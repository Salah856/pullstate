import { IPullstateAllStores, PullstateContext } from "./PullstateCore";
import { MutableRefObject, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  EAsyncEndTags,
  EPostActionContext,
  IAsyncActionBeckonOptions,
  IAsyncActionReadOptions,
  IAsyncActionResultNegative,
  IAsyncActionResultPositive,
  IAsyncActionRunOptions,
  IAsyncActionWatchOptions,
  ICreateAsyncActionOptions,
  IOCreateAsyncActionOutput,
  IPullstateAsyncCache,
  TAsyncActionBeckon,
  TAsyncActionClearAllCache,
  TAsyncActionClearAllUnwatchedCache,
  TAsyncActionClearCache,
  TAsyncActionDelayedRun,
  TAsyncActionGetCached,
  TAsyncActionRead,
  TAsyncActionResult,
  TAsyncActionRun,
  TAsyncActionSetCached,
  TAsyncActionSetCachedPayload,
  TAsyncActionUpdateCached,
  TAsyncActionWatch,
  TPullstateAsyncAction,
  TPullstateAsyncWatchResponse,
} from "./async-types";
// @ts-ignore
import produce from "immer";

const isEqual = require("fast-deep-equal/es6");

export const clientAsyncCache: IPullstateAsyncCache = {
  listeners: {},
  results: {},
  actions: {},
  actionOrd: {},
};

let asyncCreationOrdinal = 0;

export function keyFromObject(json) {
  if (json === null) {
    return "(n)";
  }

  const typeOf = typeof json;

  if (typeOf !== "object") {
    if (typeOf === "undefined") {
      return "(u)";
    } else if (typeOf === "string") {
      return ":" + json + ";";
    } else if (typeOf === "boolean" || typeOf === "number") {
      return "(" + json + ")";
    }
  }

  let prefix = "{";

  for (const key of Object.keys(json).sort()) {
    prefix += key + keyFromObject(json[key]);
  }

  return prefix + "}";
}

function notifyListeners(key: string) {
  if (clientAsyncCache.listeners.hasOwnProperty(key)) {
    // console.log(`[${key}] Notifying (${Object.keys(clientAsyncCache.listeners[key]).length}) listeners`);
    for (const watchId of Object.keys(clientAsyncCache.listeners[key])) {
      // console.log(`[${key}] Notifying listener with watch id: [${watchId}]`);
      clientAsyncCache.listeners[key][watchId]();
    }
  }
}

function clearActionCache(key: string, clearPending: boolean = true) {
  if (clearPending && clientAsyncCache.actionOrd.hasOwnProperty(key)) {
    clientAsyncCache.actionOrd[key] += 1;
  }

  // console.log(`Set ordinal for action [${key}] to ${clientAsyncCache.actionOrd[key] || "DIDNT EXIST"}`);
  // console.log(`Clearing cache for [${key}]`);
  delete clientAsyncCache.results[key];
  notifyListeners(key);
}

function actionOrdUpdate(cache: IPullstateAsyncCache, key: string): number {
  if (!cache.actionOrd.hasOwnProperty(key)) {
    cache.actionOrd[key] = 0;
  } else {
    cache.actionOrd[key] += 1;
  }

  return cache.actionOrd[key];
}

export function successResult<R, T extends string = string>(
  payload: R = (null as unknown) as R,
  tags: (EAsyncEndTags | T)[] = [],
  message: string = ""
): IAsyncActionResultPositive<R, T> {
  return {
    payload,
    tags,
    message,
    error: false,
  };
}

export function errorResult<R = any, T extends string = string>(
  tags: (EAsyncEndTags | T)[] = [],
  message: string = ""
): IAsyncActionResultNegative<T> {
  return {
    payload: null,
    tags: [EAsyncEndTags.RETURNED_ERROR, ...tags],
    message,
    error: true,
  };
}

export class PullstateAsyncError extends Error {
  message: string;
  tags: string[];

  constructor(message: string, tags: string[]) {
    super(message);
    this.tags = tags;
  }
}

type TGlobalListener = (actionKey: string, result: TAsyncActionResult<any, string>) => void;

const asyncActionGlobalListeners: TGlobalListener[] = [];

export function registerAsyncActionGlobalListener(listener: TGlobalListener) {

}

export function createAsyncAction<
  A = any,
  R = any,
  T extends string = string,
  S extends IPullstateAllStores = IPullstateAllStores
>(
  action: TPullstateAsyncAction<A, R, T, S>,
  {
    forceContext = false,
    clientStores = {} as S,
    shortCircuitHook,
    cacheBreakHook,
    postActionHook,
    subsetKey,
  }: ICreateAsyncActionOptions<A, R, T, S> = {}
): IOCreateAsyncActionOutput<A, R, T> {
  const ordinal: number = asyncCreationOrdinal++;
  const onServer: boolean = typeof window === "undefined";

  function _createKey(keyOrdinal, args: any) {
    if (subsetKey !== undefined) {
      return `${keyOrdinal}-${keyFromObject(subsetKey(args))}`;
    }
    return `${keyOrdinal}-${keyFromObject(args)}`;
  }

  let cacheBreakWatcher: { [actionKey: string]: number } = {};
  let watchIdOrd: number = 0;
  const shouldUpdate: {
    [actionKey: string]: {
      [watchId: string]: boolean;
    };
  } = {};
  // console.log(`Creating async action with ordinal: ${ordinal} - action name: ${action.name}`);

  function runPostActionHook(result: TAsyncActionResult<R, T>, args: A, stores: S, context: EPostActionContext): void {
    if (postActionHook !== undefined) {
      postActionHook({ args, result, stores, context });
    }
  }

  function getCachedResult(
    key: string,
    cache: IPullstateAsyncCache,
    args: A,
    stores: S,
    context: EPostActionContext,
    postActionEnabled: boolean,
    cacheBreakEnabled: boolean,
    fromListener: boolean
  ): TPullstateAsyncWatchResponse<R, T> | undefined {
    if (cache.results.hasOwnProperty(key)) {
      const cacheBreakLoop = cacheBreakWatcher.hasOwnProperty(key) && cacheBreakWatcher[key] > 2;
      // console.log(`[${key}] Pullstate Async: Already finished - returning cached result`);

      // Only beckon() can cache break - because watch() will not initiate the re-caching mechanism
      if (
        cacheBreakEnabled &&
        cacheBreakHook !== undefined &&
        cacheBreakHook({
          args,
          result: cache.results[key][2] as TAsyncActionResult<R, T>,
          stores,
          timeCached: cache.results[key][4],
        }) &&
        !cacheBreakLoop
      ) {
        if (cacheBreakWatcher.hasOwnProperty(key)) {
          cacheBreakWatcher[key]++;
        } else {
          cacheBreakWatcher[key] = 1;
        }

        delete cache.results[key];
      } else {
        if (cacheBreakLoop) {
          console.error(`[${key}] Pullstate detected an infinite loop caused by cacheBreakHook()
returning true too often (breaking cache as soon as your action is resolving - hence
causing beckoned actions to run the action again) in one of your AsyncActions - Pullstate prevented
further looping. Fix in your cacheBreakHook() is needed.`);
        } else {
          cacheBreakWatcher[key] = 0;
        }

        // if the cached result is "finished" (and we are not running
        // this during a listener update) we need to run the post
        // action hook with WATCH_HIT_CACHE context
        if (postActionEnabled && cache.results[key][1] && !fromListener) {
          runPostActionHook(cache.results[key][2] as TAsyncActionResult<R, T>, args, stores, context);
        }

        return cache.results[key] as TPullstateAsyncWatchResponse<R, T>;
      }
    }

    return undefined;
  }

  function createInternalAction(
    key: string,
    cache: IPullstateAsyncCache,
    args: A,
    stores: S,
    currentActionOrd: number,
    postActionEnabled: boolean,
    context: EPostActionContext
  ): () => Promise<TAsyncActionResult<R, T>> {
    return () =>
      action(args, stores)
        .then(resp => {
          if (currentActionOrd === cache.actionOrd[key]) {
            if (postActionEnabled) {
              runPostActionHook(resp as TAsyncActionResult<R, T>, args, stores, context);
            }
            cache.results[key] = [true, true, resp, false, Date.now()] as TPullstateAsyncWatchResponse<R, T>;
          }

          return resp;
        })
        .catch(e => {
          // console.log(`Pullstate async action threw error`);
          console.error(e);
          const result: TAsyncActionResult<R, T> = {
            payload: null,
            error: true,
            tags: [EAsyncEndTags.THREW_ERROR],
            message: e.message,
          };

          if (currentActionOrd === cache.actionOrd[key]) {
            if (postActionEnabled) {
              runPostActionHook(result, args, stores, context);
            }
            cache.results[key] = [true, true, result, false, Date.now()] as TPullstateAsyncWatchResponse<R, T>;
          }

          return result;
        })
        .then(resp => {
          delete cache.actions[key];
          if (!onServer) {
            notifyListeners(key);
          }
          return resp;
        });
  }

  function checkKeyAndReturnResponse(
    key: string,
    cache: IPullstateAsyncCache,
    initiate: boolean,
    ssr: boolean,
    args: A,
    stores: S,
    fromListener = false,
    postActionEnabled = true,
    cacheBreakEnabled = true,
    holdingResult: TPullstateAsyncWatchResponse<R, T> | undefined = undefined
  ): TPullstateAsyncWatchResponse<R, T> {
    const cached = getCachedResult(
      key,
      cache,
      args,
      stores,
      initiate ? EPostActionContext.BECKON_HIT_CACHE : EPostActionContext.WATCH_HIT_CACHE,
      postActionEnabled,
      cacheBreakEnabled,
      fromListener
    );

    if (cached) {
      return cached;
    }

    // console.log(`[${key}] Pullstate Async: has no results yet`);

    // check if it is already pending as an action
    if (!cache.actions.hasOwnProperty(key)) {
      const currentActionOrd = actionOrdUpdate(cache, key);

      if (initiate) {
        // if it is not pending, check if for any short circuiting before initiating
        if (shortCircuitHook !== undefined) {
          const shortCircuitResponse = shortCircuitHook({ args, stores });
          if (shortCircuitResponse !== false) {
            runPostActionHook(shortCircuitResponse, args, stores, EPostActionContext.SHORT_CIRCUIT);
            cache.results[key] = [true, true, shortCircuitResponse, false, Date.now()];
            return cache.results[key] as TPullstateAsyncWatchResponse<R, T>;
          }
        }

        // queue (on server) or start the action now (on client)
        if (ssr || !onServer) {
          cache.actions[key] = createInternalAction(
            key,
            cache,
            args,
            stores,
            currentActionOrd,
            postActionEnabled,
            EPostActionContext.BECKON_RUN
          );
        }

        if (!onServer) {
          cache.actions[key]();
        }
      } else {
        if (holdingResult) {
          const response = [...holdingResult] as TPullstateAsyncWatchResponse<R, T>;
          response[3] = true;
          return response;
        }

        return [
          false,
          false,
          {
            message: "",
            tags: [EAsyncEndTags.UNFINISHED],
            error: true,
            payload: null,
          },
          false,
          -1,
        ] as TPullstateAsyncWatchResponse<R, T>;
      }
    }

    if (holdingResult) {
      const response = [...holdingResult] as TPullstateAsyncWatchResponse<R, T>;
      response[3] = true;
      return response;
    }

    return [
      true,
      false,
      {
        message: "",
        tags: [EAsyncEndTags.UNFINISHED],
        error: true,
        payload: null,
      },
      false,
      -1,
    ];
  }

  const read: TAsyncActionRead<A, R> = (
    args = {} as A,
    { cacheBreakEnabled = true, postActionEnabled = true }: IAsyncActionReadOptions = {}
  ): R => {
    const key = _createKey(ordinal, args);

    const cache: IPullstateAsyncCache = onServer ? useContext(PullstateContext)!._asyncCache : clientAsyncCache;
    const stores = onServer || forceContext ? (useContext(PullstateContext)!.stores as S) : clientStores;

    const cached = getCachedResult(
      key,
      cache,
      args,
      stores,
      EPostActionContext.READ_HIT_CACHE,
      postActionEnabled,
      cacheBreakEnabled,
      false
    );

    if (cached) {
      if (!cached[2].error) {
        return cached[2].payload;
      } else {
        throw new PullstateAsyncError(cached[2].message, cached[2].tags);
      }
    }

    if (!cache.actions.hasOwnProperty(key)) {
      // if it is not pending, check if for any short circuiting before initiating
      if (shortCircuitHook !== undefined) {
        const shortCircuitResponse = shortCircuitHook({ args, stores });
        if (shortCircuitResponse !== false) {
          runPostActionHook(shortCircuitResponse, args, stores, EPostActionContext.SHORT_CIRCUIT);
          cache.results[key] = [true, true, shortCircuitResponse, false, Date.now()];
          if (!shortCircuitResponse.error) {
            return shortCircuitResponse.payload;
          } else {
            throw new PullstateAsyncError(shortCircuitResponse.message, shortCircuitResponse.tags);
          }
        }
      }

      const currentActionOrd = actionOrdUpdate(cache, key);
      cache.actions[key] = createInternalAction(
        key,
        cache,
        args,
        stores,
        currentActionOrd,
        postActionEnabled,
        EPostActionContext.READ_RUN
      );

      if (onServer) {
        throw new Error(
          `Pullstate Async Action: action.read() : Resolve all async state for Suspense actions before Server-side render ( make use of instance.runAsyncAction() )`
        );
      }

      throw cache.actions[key]();
    }

    if (onServer) {
      throw new Error(
        `Pullstate Async Action: action.read() : Resolve all async state for Suspense actions before Server-side render ( make use of instance.runAsyncAction() )`
      );
    }

    const watchOrd = watchIdOrd++;

    throw new Promise(resolve => {
      cache.listeners[key][watchOrd] = resolve;
    });
  };

  const useWatch: TAsyncActionWatch<A, R, T> = (
    args = {} as A,
    {
      initiate = false,
      ssr = true,
      postActionEnabled = false,
      cacheBreakEnabled = false,
      holdPrevious = false,
      dormant = false,
    }: IAsyncActionWatchOptions = {}
  ) => {
    // Where we store the current response that will be returned from our hook
    const responseRef = useRef<TPullstateAsyncWatchResponse<R, T>>();

    // For comparisons to our previous "fingerprint" / key from args
    const prevKeyRef = useRef<string>(".");

    const key = dormant ? "." : _createKey(ordinal, args);

    let watchId: MutableRefObject<number> = useRef(-1);
    if (watchId.current === -1) {
      watchId.current = watchIdOrd++;
    }

    if (!dormant) {
      if (!shouldUpdate.hasOwnProperty(key)) {
        shouldUpdate[key] = {
          [watchId.current]: true,
        };
      } else {
        shouldUpdate[key][watchId.current] = true;
      }
    }
    // console.log(`[${key}][${watchId.current}] Starting useWatch()`);

    const cache: IPullstateAsyncCache = onServer ? useContext(PullstateContext)!._asyncCache : clientAsyncCache;
    const stores = onServer || forceContext ? (useContext(PullstateContext)!.stores as S) : clientStores;

    // only listen for updates when on client
    if (!onServer) {
      const onAsyncStateChanged = () => {
        /*console.log(`[${key}][${watchId.current}] should update: ${shouldUpdate[key][watchId.current]}`);
        console.log(
          `[${key}][${watchId.current}] will update?: ${!isEqual(
            responseRef.current,
            cache.results[key]
          )} - ${responseRef.current} !== ${cache.results[key]}`
        );
        console.log(responseRef.current);
        console.log(cache.results[key]);
        console.log(cache);*/
        if (shouldUpdate[key][watchId.current] && !isEqual(responseRef.current, cache.results[key])) {
          responseRef.current = checkKeyAndReturnResponse(
            key,
            cache,
            initiate,
            ssr,
            args,
            stores,
            true,
            postActionEnabled,
            cacheBreakEnabled
          );

          setWatchUpdate(prev => {
            return prev + 1;
          });
        } /*else {
          // Way to keep our shouldUpdate keys map small (and make clearUnwatchedCache() faster)
          // - remove keys from shouldUpdate when there are no more registered listeners
          // delete shouldUpdate[key][watchId.current];
          // if (Object.keys(shouldUpdate[key]).length === 0) {
          //   delete shouldUpdate[key];
          // }
        }*/
      };

      useMemo(() => {
        if (!dormant) {
          if (!cache.listeners.hasOwnProperty(key)) {
            cache.listeners[key] = {};
          }
          cache.listeners[key][watchId.current] = onAsyncStateChanged;
          // console.log(`[${key}][${watchId}] Added listener (total now: ${Object.keys(cache.listeners[key]).length})`);
        }
      }, [key]);

      useEffect(
        () => () => {
          if (!dormant) {
            // console.log(`[${key}][${watchId}] Removing listener (before: ${Object.keys(cache.listeners[key]).length})`);
            delete cache.listeners[key][watchId.current];
            shouldUpdate[key][watchId.current] = false;
            // console.log(`[${key}][${watchId}] Removed listener (after: ${Object.keys(cache.listeners[key]).length})`);
          }
        },
        [key]
      );
    }

    // Purely for forcing this hook to update
    const [_, setWatchUpdate] = useState<number>(0);

    /*// If we've run this before, and the keys are equal, quick return with the current set result
    if (prevKeyRef.current !== null && prevKeyRef.current === key) {
      return responseRef.current;
    }*/
    // console.log(`[${key}][${watchId}] Is dormamt?: ${dormant}`);
    // console.log(`[${key}][${watchId}] CHECKING KEYS [${prevKeyRef.current} <---> ${key}]`);
    if (dormant) {
      responseRef.current =
        holdPrevious && responseRef.current && responseRef.current[1]
          ? responseRef.current
          : ([
              false,
              false,
              {
                message: "",
                tags: [EAsyncEndTags.DORMANT],
                error: true,
                payload: null,
              },
              false,
              -1,
            ] as TPullstateAsyncWatchResponse<R, T>);
      prevKeyRef.current = ".";
    } else if (prevKeyRef.current !== key) {
      // console.log(`[${key}][${watchId}] KEYS MISMATCH old !== new [${prevKeyRef.current} !== ${key}]`);
      if (prevKeyRef.current !== null && shouldUpdate.hasOwnProperty(prevKeyRef.current!)) {
        delete cache.listeners[prevKeyRef.current!][watchId.current];
        shouldUpdate[prevKeyRef.current!][watchId.current] = false;
      }

      prevKeyRef.current = key;
      responseRef.current = checkKeyAndReturnResponse(
        key,
        cache,
        initiate,
        ssr,
        args,
        stores,
        false,
        postActionEnabled,
        cacheBreakEnabled,
        // If we want to hold previous and the previous result was finished -
        // keep showing that until this new one resolves
        holdPrevious && responseRef.current && responseRef.current[1] ? responseRef.current : undefined
      );
    }

    // console.log(`[${key}][${watchId}] Returning from watch() [update no. ${_}] with response: ${JSON.stringify(responseRef.current)}`);
    return responseRef.current!;
  };

  // Same as watch - just initiated, so no need for "started" return value
  const useBeckon: TAsyncActionBeckon<A, R, T> = (
    args = {} as A,
    {
      ssr = true,
      postActionEnabled = true,
      cacheBreakEnabled = true,
      holdPrevious = false,
      dormant = false,
    }: IAsyncActionBeckonOptions = {}
  ) => {
    const result = useWatch(args, { initiate: true, ssr, postActionEnabled, cacheBreakEnabled, holdPrevious, dormant });
    return [result[1], result[2], result[3]];
  };

  const run: TAsyncActionRun<A, R, T> = async (
    args = {} as A,
    {
      treatAsUpdate = false,
      ignoreShortCircuit = false,
      respectCache = false,
      _asyncCache = clientAsyncCache,
      _stores = clientStores,
    }: IAsyncActionRunOptions = {}
  ): Promise<TAsyncActionResult<R, T>> => {
    const key = _createKey(ordinal, args);
    // console.log(`[${key}] Running action`);
    // console.log(_asyncCache);

    if (respectCache) {
      const cached = getCachedResult(
        key,
        _asyncCache,
        args,
        _stores,
        EPostActionContext.RUN_HIT_CACHE,
        true,
        true,
        false
      );

      if (cached) {
        return cached[2];
      }

      /*if (
        cacheBreakHook !== undefined &&
        cacheBreakHook({
          args,
          result: _asyncCache.results[key][2] as TAsyncActionResult<R, T>,
          stores: _stores,
          timeCached: _asyncCache.results[key][4],
        })
      ) {
        delete _asyncCache.results[key];
      } else {
        // if this is a "finished" cached result we need to run the post action hook with RUN_HIT_CACHE context
        if (_asyncCache.results[key][1]) {
          runPostActionHook(
            _asyncCache.results[key][2] as TAsyncActionResult<R, T>,
            args,
            _stores,
            EPostActionContext.RUN_HIT_CACHE
          );
          return _asyncCache.results[key][2] as TAsyncActionResult<R, T>;
        } else {
          return _asyncCache.results[key][2] as TAsyncActionResult<R, T>;
        }
      }*/
    }

    if (!ignoreShortCircuit && shortCircuitHook !== undefined) {
      const shortCircuitResponse = shortCircuitHook({ args, stores: _stores });
      if (shortCircuitResponse !== false) {
        _asyncCache.results[key] = [true, true, shortCircuitResponse, false, Date.now()];
        runPostActionHook(shortCircuitResponse, args, _stores, EPostActionContext.SHORT_CIRCUIT);
        notifyListeners(key);
        return shortCircuitResponse;
      }
    }

    const [, prevFinished, prevResp, prevUpdate, prevCacheTime] = _asyncCache.results[key] || [
      false,
      false,
      {
        error: true,
        message: "",
        payload: null,
        tags: [EAsyncEndTags.UNFINISHED],
      } as IAsyncActionResultNegative<T>,
      false,
      -1,
    ];

    if (prevFinished && treatAsUpdate) {
      _asyncCache.results[key] = [true, true, prevResp, true, prevCacheTime];
    } else {
      _asyncCache.results[key] = [
        true,
        false,
        {
          error: true,
          message: "",
          payload: null,
          tags: [EAsyncEndTags.UNFINISHED],
        } as IAsyncActionResultNegative<T>,
        false,
        -1,
      ];
    }

    notifyListeners(key);
    let currentActionOrd = actionOrdUpdate(_asyncCache, key);

    _asyncCache.actions[key] = createInternalAction(
      key,
      _asyncCache,
      args,
      _stores,
      currentActionOrd,
      true,
      EPostActionContext.DIRECT_RUN
    );
    return _asyncCache.actions[key]() as Promise<TAsyncActionResult<R, T>>;
    /*try {

      // const result: TAsyncActionResult<R, T> = await action(args, _stores);

      /!*if (currentActionOrd === _asyncCache.actionOrd[key]) {
        _asyncCache.results[key] = [true, true, result, false, Date.now()];
        runPostActionHook(result, args, _stores, EPostActionContext.DIRECT_RUN);
        notifyListeners(key);
      }

      return result;*!/
    } catch (e) {
      console.error(e);

      const result: IAsyncActionResultNegative<T> = {
        error: true,
        message: e.message,
        tags: [EAsyncEndTags.THREW_ERROR],
        payload: null,
      };

      if (currentActionOrd === _asyncCache.actionOrd[key]) {
        _asyncCache.results[key] = [true, true, result, false, Date.now()];
        runPostActionHook(result, args, _stores, EPostActionContext.DIRECT_RUN);
        notifyListeners(key);
      }

      return result;
    }*/
  };

  const clearCache: TAsyncActionClearCache<A> = (args = {} as A) => {
    const key = _createKey(ordinal, args);
    clearActionCache(key);
  };

  const clearAllCache: TAsyncActionClearAllCache = () => {
    for (const key of Object.keys(clientAsyncCache.actionOrd)) {
      if (key.startsWith(`${ordinal}-`)) {
        clearActionCache(key);
      }
    }
  };

  const clearAllUnwatchedCache: TAsyncActionClearAllUnwatchedCache = () => {
    for (const key of Object.keys(shouldUpdate)) {
      if (!Object.values(shouldUpdate[key]).some(su => su)) {
        delete shouldUpdate[key];
        clearActionCache(key, false);
      }
    }
  };

  const setCached: TAsyncActionSetCached<A, R, T> = (args, result, options) => {
    const { notify = true } = options || {};
    const key = _createKey(ordinal, args);

    const cache: IPullstateAsyncCache = onServer ? useContext(PullstateContext)!._asyncCache : clientAsyncCache;

    cache.results[key] = [true, true, result, false, Date.now()];
    if (notify) {
      notifyListeners(key);
    }
  };

  const setCachedPayload: TAsyncActionSetCachedPayload<A, R> = (args, payload, options) => {
    return setCached(args, successResult(payload), options);
  };

  const updateCached: TAsyncActionUpdateCached<A, R> = (args, updater, options) => {
    const { notify = true, resetTimeCached = true, runPostActionHook: postAction = false } = options || {};

    const key = _createKey(ordinal, args);

    const cache: IPullstateAsyncCache = onServer ? useContext(PullstateContext)!._asyncCache : clientAsyncCache;

    if (cache.results.hasOwnProperty(key) && !cache.results[key][2].error) {
      const currentCached: R = cache.results[key][2].payload;

      const newResult = {
        payload: produce(currentCached, s => updater(s, currentCached)) as R,
        error: false,
        message: cache.results[key][2].message,
        tags: cache.results[key][2].tags,
      } as IAsyncActionResultPositive<R, T>;

      if (postAction) {
        runPostActionHook(newResult, args, clientStores, EPostActionContext.CACHE_UPDATE);
      }

      cache.results[key] = [
        true,
        true,
        newResult,
        cache.results[key][3],
        resetTimeCached ? Date.now() : cache.results[key][4],
      ];
      // cache.results[key][2].payload = produce(currentCached as any, s => updater(s, currentCached));
      if (notify) {
        notifyListeners(key);
      }
    }
  };

  const getCached: TAsyncActionGetCached<A, R, T> = (args = {} as A, options) => {
    const { checkCacheBreak = false } = options || {};
    const key = _createKey(ordinal, args);

    let cacheBreakable = false;

    const cache: IPullstateAsyncCache = onServer ? useContext(PullstateContext)!._asyncCache : clientAsyncCache;

    if (cache.results.hasOwnProperty(key)) {
      if (checkCacheBreak && cacheBreakHook !== undefined) {
        const stores = onServer ? (useContext(PullstateContext)!.stores as S) : clientStores;

        if (
          cacheBreakHook({
            args,
            result: cache.results[key][2] as TAsyncActionResult<R, T>,
            stores,
            timeCached: cache.results[key][4],
          })
        ) {
          cacheBreakable = true;
        }
      }

      const [started, finished, result, updating, timeCached] = cache.results[key];
      return {
        started,
        finished,
        result: result as TAsyncActionResult<R, T>,
        existed: true,
        cacheBreakable,
        updating,
        timeCached,
      };
    } else {
      return {
        started: false,
        finished: false,
        result: {
          message: "",
          tags: [EAsyncEndTags.UNFINISHED],
          error: true,
          payload: null,
        },
        updating: false,
        existed: false,
        cacheBreakable,
        timeCached: -1,
      };
    }
  };

  let delayedRunActionTimeout;

  const delayedRun: TAsyncActionDelayedRun<A> = (
    args = {} as A,
    { clearOldRun = true, delay, immediateIfCached = true, ...otherRunOptions }
  ) => {
    if (clearOldRun) {
      clearTimeout(delayedRunActionTimeout);
    }

    if (immediateIfCached) {
      const { finished, cacheBreakable } = getCached(args, { checkCacheBreak: true });

      if (finished && !cacheBreakable) {
        run(args, otherRunOptions);
        return () => {};
      }
    }

    let ref = { cancelled: false };

    delayedRunActionTimeout = setTimeout(() => {
      if (!ref.cancelled) {
        run(args, otherRunOptions);
      }
    }, delay);

    return () => {
      ref.cancelled = true;
    };
  };

  return {
    read,
    useBeckon,
    useWatch,
    run,
    delayedRun,
    clearCache,
    clearAllCache,
    clearAllUnwatchedCache,
    getCached,
    setCached,
    setCachedPayload,
    updateCached,
  };
}
