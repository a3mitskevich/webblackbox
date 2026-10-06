import type { NetworkWaterfallEntry } from "@webblackbox/player-sdk";

import { sha256HexFromBytes } from "../../../lib/hash.js";
import { createReplayHeaders, shouldAttachReplayBody } from "../../../lib/replay.js";

/** A replay that hangs (a dead host, a never-ending stream) gives up after this long. */
export const REPLAY_TIMEOUT_MS = 30_000;

export type ReplayOutcome =
  | {
      ok: true;
      status: number;
      statusText: string;
      durationMs: number;
      bodyBytes: number;
      /** `null` when the recording has no complete body to compare with. */
      bodyMatches: boolean | null;
    }
  /** The recorded request body is cut or was not kept: sending it would not repeat the request. */
  | { ok: false; refused: "request-body-incomplete" }
  | { ok: false; error: string };

export type ReplayDeps = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  hash: (bytes: Uint8Array<ArrayBuffer>) => Promise<string | null>;
  timeout: (ms: number) => AbortSignal | undefined;
};

const browserDeps = (): ReplayDeps => ({
  fetch: (url, init) => window.fetch(url, init),
  now: () => performance.now(),
  hash: sha256HexFromBytes,
  timeout: (ms) => (typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined)
});

/** The request sent a body the archive does not hold in full (cut at the limit, or skipped). */
export function isRequestBodyIncomplete(entry: NetworkWaterfallEntry): boolean {
  if (entry.requestBodyTruncated === true || entry.requestBodySkipReason !== undefined) {
    return true;
  }

  return entry.requestHasBody === true && typeof entry.requestBodyText !== "string";
}

/**
 * Sends a recorded request again from the player page (classic "Replay request"): recorded headers
 * minus hop-by-hop, cookie and redacted ones, the recorded body for non-GET methods. The archive
 * is untrusted, so the request goes without the viewer's cookies or referrer and is refused when
 * its body was not recorded in full. The answer is compared with the recording by status and by
 * the SHA-256 of the body bytes (the archive's blob hash).
 */
export async function replayRequest(
  entry: NetworkWaterfallEntry,
  deps: ReplayDeps = browserDeps()
): Promise<ReplayOutcome> {
  const method = entry.method.toUpperCase();
  const attachBody = shouldAttachReplayBody(method, entry.requestBodyText);

  if (method !== "GET" && method !== "HEAD" && isRequestBodyIncomplete(entry)) {
    return { ok: false, refused: "request-body-incomplete" };
  }

  const signal = deps.timeout(REPLAY_TIMEOUT_MS);
  const init: RequestInit = {
    method,
    headers: createReplayHeaders(entry.requestHeaders),
    credentials: "omit",
    referrerPolicy: "no-referrer",
    ...(attachBody ? { body: entry.requestBodyText } : {}),
    ...(signal ? { signal } : {})
  };
  const started = deps.now();

  try {
    const response = await deps.fetch(entry.url, init);
    const body = new Uint8Array(await response.arrayBuffer());
    const durationMs = deps.now() - started;
    const comparable = Boolean(entry.responseBodyHash) && entry.responseBodyTruncated !== true;
    const hash = comparable ? await deps.hash(body) : null;

    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      durationMs,
      bodyBytes: body.byteLength,
      bodyMatches: comparable ? hash === entry.responseBodyHash : null
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
