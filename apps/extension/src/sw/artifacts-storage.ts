import type { CapturePolicy } from "@webblackbox/protocol";
import type { RawRecorderEvent } from "@webblackbox/recorder";
import { capStorageValue, capturesPageStorageInFullMode } from "webblackbox/capture-scope";

import { evaluateExpression, sendCdpCommand } from "./artifacts-cdp.js";
import { withCdpCommandTimeout } from "./cdp-command.js";
import { CDP_ARTIFACT_TIMEOUT_MS } from "./full-cdp.js";
import { rememberablePageUrl, type SessionRuntime } from "./session-registry.js";
import {
  FULL_MODE_STORAGE_SNAPSHOT_MAX_ITEMS,
  buildLocalStorageSnapshotExpression,
  parseStorageSnapshotMeta,
  type LocalStorageSnapshotMode
} from "./storage-snapshot.js";

const VISITED_PAGE_URLS_MAX = 20;

/**
 * What the cookie/storage snapshots need from the service worker: raw-event ingestion. Everything
 * else (debugger, blob storage, visited URLs) is read from the session runtime.
 */
export type StorageArtifactsDeps = {
  ingestRawEvent: (rawEvent: RawRecorderEvent) => void;
};

export type StorageArtifactsController = {
  captureCookieValues: (runtime: SessionRuntime, reason: string) => Promise<void>;
  captureStorageSnapshots: (runtime: SessionRuntime, reason: string) => Promise<void>;
  rememberVisitedPageUrl: (runtime: SessionRuntime, rawUrl: string) => void;
};

export function createStorageArtifactsController(
  deps: StorageArtifactsDeps
): StorageArtifactsController {
  function rememberVisitedPageUrl(runtime: SessionRuntime, rawUrl: string): void {
    const [url] = rememberablePageUrl(rawUrl) ?? [];

    if (!url || runtime.visitedPageUrls.has(url)) {
      return;
    }

    if (runtime.visitedPageUrls.size >= VISITED_PAGE_URLS_MAX) {
      const oldest = runtime.visitedPageUrls.values().next().value;

      if (oldest !== undefined) {
        runtime.visitedPageUrls.delete(oldest);
      }
    }

    runtime.visitedPageUrls.add(url);
  }

  /**
   * `cookies: allow`: every cookie of the page with its value (HttpOnly ones too, which the page
   * cannot read), inline as `cookies` records so the recorder's cookie-name rules can mask values.
   */
  async function captureCookieValues(runtime: SessionRuntime, reason: string): Promise<void> {
    if (!runtime.cdpRouter) {
      return;
    }

    // Sent directly (not through `sendCdpCommand`) so the snapshot at stop still runs. The pages
    // the tab showed only; Storage.getCookies would list every site in the browser.
    const urls = [...runtime.visitedPageUrls];
    const outcome = await withCdpCommandTimeout(
      runtime.cdpRouter.send<{ cookies?: unknown[] }>(
        { tabId: runtime.tabId },
        "Network.getCookies",
        urls.length > 0 ? { urls } : undefined
      ),
      CDP_ARTIFACT_TIMEOUT_MS
    );
    const result = outcome.ok ? outcome.value : undefined;

    if (!result?.cookies) {
      return;
    }

    const cookies = result.cookies
      .slice(0, FULL_MODE_STORAGE_SNAPSHOT_MAX_ITEMS)
      .flatMap((entry) => {
        const row = asRecord(entry);
        const name = asString(row?.name);

        if (!row || name === null || typeof row.value !== "string") {
          return [];
        }

        return [
          {
            name,
            ...capStorageValue(row.value),
            domain: asString(row.domain) ?? undefined,
            path: asString(row.path) ?? undefined,
            httpOnly: row.httpOnly === true,
            secure: row.secure === true,
            sameSite: asString(row.sameSite) ?? undefined,
            expires: typeof row.expires === "number" ? row.expires : undefined
          }
        ];
      });

    deps.ingestRawEvent({
      source: "system",
      rawType: "cdp.storage.cookie.snapshot",
      sid: runtime.sid,
      tabId: runtime.tabId,
      t: Date.now(),
      mono: monotonicTime(),
      payload: {
        reason,
        count: result.cookies.length,
        truncated: result.cookies.length > cookies.length,
        mode: "allow",
        redacted: false,
        cookies
      }
    });
  }

  async function captureStorageSnapshots(runtime: SessionRuntime, reason: string): Promise<void> {
    if (!runtime.cdpRouter) {
      return;
    }

    const policy = runtime.config.capturePolicy;

    // The page agent records localStorage and IndexedDB itself (inline, through the redactor);
    // the CDP snapshots below would duplicate them in blobs the redactor never sees. Cookie names
    // stay on CDP: `document.cookie` cannot see HttpOnly cookies.
    const pageRecordsStorage = !!policy && capturesPageStorageInFullMode(policy.categories);

    if (policy?.categories.cookies === "allow") {
      await captureCookieValues(runtime, reason);
    }

    const cookies =
      policy?.categories.cookies === "names-only"
        ? await sendCdpCommand<{ cookies?: unknown[] }>(
            runtime,
            { tabId: runtime.tabId },
            // The page's cookies only; Storage.getCookies would list every site in the browser.
            "Network.getCookies"
          )
        : null;

    if (cookies?.cookies) {
      const cookieNames = cookies.cookies
        .map((entry) => asString(asRecord(entry)?.name))
        .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
        .slice(0, FULL_MODE_STORAGE_SNAPSHOT_MAX_ITEMS);
      const bytes = new TextEncoder().encode(JSON.stringify(cookieNames));
      const hash = await runtime.pipeline.putBlob("application/json", bytes);

      deps.ingestRawEvent({
        source: "system",
        rawType: "cdp.storage.cookie.snapshot",
        sid: runtime.sid,
        tabId: runtime.tabId,
        t: Date.now(),
        mono: monotonicTime(),
        payload: {
          hash,
          count: cookies.cookies.length,
          sampledCount: cookieNames.length,
          truncated: cookies.cookies.length > cookieNames.length,
          redacted: true,
          reason
        }
      });
    }

    const localStorageMode = pageRecordsStorage ? null : resolveLocalStorageSnapshotMode(policy);
    const localStorageData = localStorageMode
      ? await evaluateExpression(runtime, buildLocalStorageSnapshotExpression(localStorageMode))
      : null;

    if (typeof localStorageData === "string") {
      const bytes = new TextEncoder().encode(localStorageData);
      const hash = await runtime.pipeline.putBlob("application/json", bytes);
      const parsed = parseStorageSnapshotMeta(localStorageData);

      deps.ingestRawEvent({
        source: "system",
        rawType: "cdp.storage.local.snapshot",
        sid: runtime.sid,
        tabId: runtime.tabId,
        t: Date.now(),
        mono: monotonicTime(),
        payload: {
          hash,
          count: parsed?.count,
          sampledCount: parsed?.sampledCount,
          truncated: parsed?.truncated,
          mode: localStorageMode,
          redacted: localStorageMode !== "allow",
          reason
        }
      });
    }

    const origin =
      !pageRecordsStorage && policy?.categories.indexedDb === "names-only"
        ? await evaluateExpression(runtime, "location.origin")
        : null;

    if (typeof origin === "string") {
      const dbNames = await sendCdpCommand<{ databaseNames?: string[] }>(
        runtime,
        { tabId: runtime.tabId },
        "IndexedDB.requestDatabaseNames",
        {
          securityOrigin: origin
        }
      );

      if (dbNames?.databaseNames) {
        const bytes = new TextEncoder().encode(JSON.stringify(dbNames.databaseNames));
        const hash = await runtime.pipeline.putBlob("application/json", bytes);

        deps.ingestRawEvent({
          source: "system",
          rawType: "cdp.storage.idb.snapshot",
          sid: runtime.sid,
          tabId: runtime.tabId,
          t: Date.now(),
          mono: monotonicTime(),
          payload: {
            origin,
            schemaHash: hash,
            mode: "schema-only",
            reason
          }
        });
      }
    }
  }

  return {
    captureCookieValues,
    captureStorageSnapshots,
    rememberVisitedPageUrl
  };
}

export function resolveLocalStorageSnapshotMode(
  policy: CapturePolicy | undefined
): LocalStorageSnapshotMode | null {
  if (policy?.categories.storage === "allow" || policy?.categories.storage === "lengths-only") {
    return policy.categories.storage;
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function monotonicTime(): number {
  if (typeof performance === "undefined") {
    return Date.now();
  }

  return performance.timeOrigin + performance.now();
}
