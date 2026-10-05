import type { NetworkWaterfallEntry } from "@webblackbox/player-sdk";

import { sha256HexFromText } from "../../../lib/hash.js";
import { createReplayHeaders, shouldAttachReplayBody } from "../../../lib/replay.js";

export type ReplayOutcome =
  | {
      ok: true;
      status: number;
      statusText: string;
      durationMs: number;
      bodyBytes: number;
      /** `null` when the recording has no body to compare with. */
      bodyMatches: boolean | null;
    }
  | { ok: false; error: string };

export type ReplayDeps = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  hash: (text: string) => Promise<string | null>;
};

const browserDeps = (): ReplayDeps => ({
  fetch: (url, init) => window.fetch(url, init),
  now: () => performance.now(),
  hash: sha256HexFromText
});

/**
 * Sends a recorded request again from the player page (classic "Replay request"): recorded headers
 * minus hop-by-hop, cookie and redacted ones, the recorded body for non-GET methods. The answer is
 * compared with the recording by status and body hash.
 */
export async function replayRequest(
  entry: NetworkWaterfallEntry,
  deps: ReplayDeps = browserDeps()
): Promise<ReplayOutcome> {
  const method = entry.method.toUpperCase();
  const init: RequestInit = { method, headers: createReplayHeaders(entry.requestHeaders) };

  if (shouldAttachReplayBody(method, entry.requestBodyText)) {
    init.body = entry.requestBodyText;
  }

  const started = deps.now();

  try {
    const response = await deps.fetch(entry.url, init);
    const body = await response.text();
    const durationMs = deps.now() - started;
    const hash = entry.responseBodyHash ? await deps.hash(body) : null;

    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      durationMs,
      bodyBytes: new TextEncoder().encode(body).byteLength,
      bodyMatches: entry.responseBodyHash ? hash === entry.responseBodyHash : null
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
