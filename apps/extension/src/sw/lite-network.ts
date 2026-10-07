import type { RawRecorderEvent } from "@webblackbox/recorder";

import type { ChromeApi } from "../shared/chrome-api.js";
import {
  buildLiteNetworkFailureRawEvent,
  buildLiteNetworkRequestRawEvent,
  buildLiteNetworkResponseRawEvent
} from "./lite-network-baseline.js";
import {
  buildRequestMetaKey,
  deleteRequestMeta,
  getRequestMeta,
  upsertRequestMeta
} from "./request-meta.js";
import type { SessionRuntime } from "./session-registry.js";

/**
 * What the lite webRequest baseline needs from the service worker: the browser's webRequest
 * API, raw-event ingestion and session lookups. Listener bookkeeping stays inside the
 * controller; per-request metadata stays on the session runtime (`runtime.requestMeta`).
 */
export type LiteNetworkBaselineDeps = {
  webRequest: ChromeApi["webRequest"];
  ingestRawEvent: (rawEvent: RawRecorderEvent) => void;
  getRuntimeByTab: (tabId: number) => SessionRuntime | undefined;
  tabRuntimes: () => IterableIterator<SessionRuntime>;
};

export type LiteNetworkBaselineController = {
  /** Subscribes the webRequest listeners once; later calls are no-ops. */
  install: () => void;
  /** Unsubscribes once no lite session can use the baseline anymore. */
  uninstallIfUnused: () => void;
};

/**
 * Lite mode's network baseline: `webRequest` gives every request a start/end/failure event even
 * when the page hooks miss it (service-worker fetches, opaque responses). Full mode reads the
 * network through CDP instead, so only lite runtimes are resolved here.
 */
export function createLiteNetworkBaselineController(
  deps: LiteNetworkBaselineDeps
): LiteNetworkBaselineController {
  let cleanup: (() => void) | null = null;

  function install(): void {
    if (!deps.webRequest || cleanup) {
      return;
    }

    const filter = { urls: ["<all_urls>"] };
    const onBeforeRequest = (details: {
      requestId: string;
      tabId: number;
      frameId?: number;
      method?: string;
      url: string;
      timeStamp?: number;
    }) => {
      const runtime = resolveLiteRuntimeForWebRequest(details.tabId);

      if (!runtime) {
        return;
      }

      const startedAt = normalizeLiteNetworkTimestamp(details.timeStamp);
      upsertRequestMeta(runtime.requestMeta, buildRequestMetaKey(details.requestId), {
        url: details.url,
        method: details.method,
        startedAt
      });

      deps.ingestRawEvent(
        buildLiteNetworkRequestRawEvent(
          {
            sid: runtime.sid,
            tabId: runtime.tabId,
            frame: normalizeContentFrameId(details.frameId)
          },
          {
            requestId: details.requestId,
            method: details.method,
            url: details.url,
            timeStamp: startedAt
          }
        )
      );
    };

    const onCompleted = (details: {
      requestId: string;
      tabId: number;
      frameId?: number;
      method?: string;
      url: string;
      statusCode?: number;
      statusLine?: string;
      timeStamp?: number;
    }) => {
      const runtime = resolveLiteRuntimeForWebRequest(details.tabId);

      if (!runtime) {
        return;
      }

      const metadata = getRequestMeta(runtime.requestMeta, buildRequestMetaKey(details.requestId));
      const endedAt = normalizeLiteNetworkTimestamp(details.timeStamp);

      deps.ingestRawEvent(
        buildLiteNetworkResponseRawEvent(
          {
            sid: runtime.sid,
            tabId: runtime.tabId,
            frame: normalizeContentFrameId(details.frameId)
          },
          {
            requestId: details.requestId,
            method: details.method ?? metadata?.method,
            url: details.url ?? metadata?.url ?? "unknown://request",
            statusCode: details.statusCode,
            statusLine: details.statusLine,
            timeStamp: endedAt,
            duration:
              typeof metadata?.startedAt === "number"
                ? Math.max(0, endedAt - metadata.startedAt)
                : undefined
          }
        )
      );

      deleteRequestMeta(runtime.requestMeta, buildRequestMetaKey(details.requestId));
    };

    const onErrorOccurred = (details: {
      requestId: string;
      tabId: number;
      frameId?: number;
      method?: string;
      url: string;
      error?: string;
      timeStamp?: number;
    }) => {
      const runtime = resolveLiteRuntimeForWebRequest(details.tabId);

      if (!runtime) {
        return;
      }

      const metadata = getRequestMeta(runtime.requestMeta, buildRequestMetaKey(details.requestId));
      const endedAt = normalizeLiteNetworkTimestamp(details.timeStamp);

      deps.ingestRawEvent(
        buildLiteNetworkFailureRawEvent(
          {
            sid: runtime.sid,
            tabId: runtime.tabId,
            frame: normalizeContentFrameId(details.frameId)
          },
          {
            requestId: details.requestId,
            method: details.method ?? metadata?.method,
            url: details.url ?? metadata?.url ?? "unknown://request",
            timeStamp: endedAt,
            duration:
              typeof metadata?.startedAt === "number"
                ? Math.max(0, endedAt - metadata.startedAt)
                : undefined,
            error: details.error
          }
        )
      );

      deleteRequestMeta(runtime.requestMeta, buildRequestMetaKey(details.requestId));
    };

    deps.webRequest.onBeforeRequest.addListener(onBeforeRequest, filter);
    deps.webRequest.onCompleted.addListener(onCompleted, filter);
    deps.webRequest.onErrorOccurred.addListener(onErrorOccurred, filter);

    cleanup = () => {
      deps.webRequest?.onBeforeRequest.removeListener(onBeforeRequest);
      deps.webRequest?.onCompleted.removeListener(onCompleted);
      deps.webRequest?.onErrorOccurred.removeListener(onErrorOccurred);
      cleanup = null;
    };
  }

  function uninstallIfUnused(): void {
    if (!cleanup || hasActiveLiteRuntime()) {
      return;
    }

    cleanup();
  }

  function hasActiveLiteRuntime(): boolean {
    for (const runtime of deps.tabRuntimes()) {
      if (runtime.mode === "lite" && !runtime.stopping && !runtime.stoppedAt) {
        return true;
      }
    }

    return false;
  }

  function resolveLiteRuntimeForWebRequest(tabId: number): SessionRuntime | undefined {
    if (!Number.isFinite(tabId) || tabId < 0) {
      return undefined;
    }

    const runtime = deps.getRuntimeByTab(tabId);

    if (!runtime || runtime.mode !== "lite" || runtime.stopping) {
      return undefined;
    }

    return runtime;
  }

  return {
    install,
    uninstallIfUnused
  };
}

function normalizeLiteNetworkTimestamp(candidate: unknown): number {
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0
    ? Math.round(candidate)
    : Date.now();
}

function normalizeContentFrameId(value: unknown): string | undefined {
  const candidate = typeof value === "number" && Number.isFinite(value) ? value : null;

  if (candidate === null) {
    return undefined;
  }

  const frameId = Math.max(0, Math.floor(candidate));

  if (frameId <= 0) {
    return undefined;
  }

  return `content-frame-${frameId}`;
}
