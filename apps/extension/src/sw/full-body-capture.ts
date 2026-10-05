import type { BodySkipReason, NetworkBodySkippedPayload } from "@webblackbox/protocol";

import {
  isLikelyTextualResourceType,
  isTextualMimeType,
  normalizeMimeType,
  ruleSkipReason,
  type BodyCaptureRule
} from "./body-capture-utils.js";
import { isBrowserInternalUrl } from "@webblackbox/recorder";

import type { RequestMetaEntry } from "./request-meta.js";

/** Bodies read from CDP at the same time; more wait in the queue. */
export const FULL_BODY_FETCH_CONCURRENCY = 4;
/** Bodies waiting to be read; past this a finished response is recorded as `backlog`. */
export const FULL_BODY_FETCH_MAX_PENDING = 1_000;
/** Bodies kept per session; later ones are recorded as `session-limit`. */
export const FULL_BODY_MAX_PER_SESSION = 20_000;
/** Body bytes kept per session (after the per-body limit); later ones are `session-limit`. */
export const FULL_BODY_MAX_BYTES_PER_SESSION = 512 * 1024 * 1024;
/** A body is not read when its encoded size exceeds this many times the per-body limit. */
export const FULL_BODY_OVERSIZE_FACTOR = 2;

/** Responses waiting for `loadingFinished`; the oldest are forgotten past this. */
export const FULL_BODY_MAX_AWAITING_FINISH = 5_000;

/** Resource types whose bodies are never text the policy asks for. */
const NON_TEXT_RESOURCE_TYPES = new Set(["Image", "Media", "Font"]);
/** Statuses that never carry a body. 304 is kept: CDP serves the cached body for it. */
const BODYLESS_STATUSES = new Set([101, 204, 205]);
/**
 * CDP errors meaning the browser no longer holds the body: evicted from its network buffer
 * (about 200 MB by default) or never kept ("No data found for resource with given identifier").
 */
const NOT_RETAINED_ERROR_PATTERN = /evicted|no (resource|data)\b.*\bfound/i;
/** CDP error for a request body the browser cannot expose (e.g. a streamed body). */
const UNAVAILABLE_POST_DATA_PATTERN = /no post data available/i;

export type CdpReadOutcome<TResult> = { ok: true; value: TResult } | { ok: false; error: string };

export type ResponseBodyRead = { body?: string; base64Encoded?: boolean };

export type FinishedResponse = {
  requestId: string;
  sessionId?: string;
  encodedDataLength?: number;
  meta: RequestMetaEntry | undefined;
};

export type ReadBody = { body: string; base64Encoded: boolean };

export type FullBodyCaptureDeps = {
  /** Whether the session's policy asks for bodies at all (full mode, `body-allowlist`). */
  isEnabled: () => boolean;
  resolveRule: (url: string, mimeType: string | undefined) => BodyCaptureRule;
  readResponseBody: (
    requestId: string,
    sessionId: string | undefined
  ) => Promise<CdpReadOutcome<ResponseBodyRead>>;
  /** Stores a read body, records `network.body` and returns the bytes kept in the archive. */
  storeBody: (
    response: FinishedResponse,
    read: ReadBody,
    rule: BodyCaptureRule,
    mimeType: string | undefined
  ) => Promise<number>;
  /** Records `network.body.skipped`. */
  emitSkip: (payload: NetworkBodySkippedPayload) => void;
};

type PendingFetch = {
  response: FinishedResponse;
  rule: BodyCaptureRule;
  mimeType: string | undefined;
};

type SkipDetail = Omit<NetworkBodySkippedPayload, "reqId" | "side" | "reason">;

/**
 * Response bodies of a full-mode session. Every textual response the policy asks for ends as a
 * `network.body` or a `network.body.skipped` with the reason; nothing is dropped silently.
 *
 * Decisions run synchronously on `Network.loadingFinished`; the CDP reads run in a small pool, so
 * a burst of parallel requests queues instead of being dropped.
 */
export class FullBodyCapture {
  private readonly queue: PendingFetch[] = [];

  private readonly inFlight = new Set<Promise<void>>();

  /** Responses seen but not finished yet, by request key (session + request id). */
  private readonly awaitingFinish = new Map<string, FinishedResponse>();

  private storedCount = 0;

  private storedBytes = 0;

  private closed = false;

  public constructor(private readonly deps: FullBodyCaptureDeps) {}

  /** A response arrived; its body is decided when it finishes (or when the recording stops). */
  public onResponseReceived(response: FinishedResponse): void {
    if (this.closed || !this.deps.isEnabled()) {
      return;
    }

    const key = requestKey(response);
    this.awaitingFinish.delete(key);

    if (this.awaitingFinish.size >= FULL_BODY_MAX_AWAITING_FINISH) {
      const oldest = this.awaitingFinish.keys().next().value;

      if (oldest !== undefined) {
        this.awaitingFinish.delete(oldest);
      }
    }

    this.awaitingFinish.set(key, response);
  }

  /** The request failed or was cancelled: there is no body to keep. */
  public onLoadingFailed(requestId: string, sessionId: string | undefined): void {
    this.awaitingFinish.delete(requestKey({ requestId, sessionId }));
  }

  public onLoadingFinished(response: FinishedResponse): void {
    this.awaitingFinish.delete(requestKey(response));

    if (this.closed || !this.deps.isEnabled()) {
      return;
    }

    const { meta } = response;

    if (!meta) {
      // The response event was never seen (or expired), so the body cannot be classified.
      this.skip(response, "fetch-failed", { detail: "no response metadata" });
      return;
    }

    const mimeType = normalizeMimeType(meta.mimeType);

    // Extension and browser-internal resources are not the app's traffic (the recorder drops them).
    if (!isTextualResponse(meta, mimeType) || isBrowserInternalUrl(meta.url ?? "")) {
      return;
    }

    const rule = this.deps.resolveRule(meta.url ?? "", mimeType);

    if (!rule.enabled) {
      this.skip(response, ruleSkipReason(rule, mimeType), { mimeType });
      return;
    }

    if (
      response.encodedDataLength !== undefined &&
      response.encodedDataLength > rule.maxBytes * FULL_BODY_OVERSIZE_FACTOR
    ) {
      this.skip(response, "too-large", {
        mimeType,
        size: response.encodedDataLength,
        limit: rule.maxBytes
      });
      return;
    }

    if (this.isSessionBudgetUsed()) {
      this.skip(response, "session-limit", { mimeType, limit: FULL_BODY_MAX_PER_SESSION });
      return;
    }

    if (this.queue.length >= FULL_BODY_FETCH_MAX_PENDING) {
      this.skip(response, "backlog", { mimeType, limit: FULL_BODY_FETCH_MAX_PENDING });
      return;
    }

    this.queue.push({ response, rule, mimeType });
    this.pump();
  }

  /** Bodies queued or being read. */
  public pendingCount(): number {
    return this.queue.length + this.inFlight.size;
  }

  /**
   * Waits for queued bodies (up to `timeoutMs`), then closes: whatever is still waiting is
   * recorded as `backlog` and late reads are recorded the same way.
   */
  public async drain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs);

    while (this.pendingCount() > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled([...this.inFlight]),
        delay(Math.max(1, deadline - Date.now()))
      ]);
    }

    this.close();
  }

  /**
   * Stops reading. Queued bodies are recorded as `backlog`; textual responses that never finished
   * loading (e.g. a body the page never read) as `unavailable`.
   */
  public close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;

    for (const pending of this.queue.splice(0, this.queue.length)) {
      this.skip(pending.response, "backlog", {
        mimeType: pending.mimeType,
        detail: "recording stopped"
      });
    }

    const unfinished = [...this.awaitingFinish.values()];
    this.awaitingFinish.clear();

    if (!this.deps.isEnabled()) {
      return;
    }

    for (const response of unfinished) {
      const mimeType = normalizeMimeType(response.meta?.mimeType);

      if (
        response.meta &&
        isTextualResponse(response.meta, mimeType) &&
        !isBrowserInternalUrl(response.meta.url ?? "")
      ) {
        this.skip(response, "unavailable", {
          mimeType,
          detail: "the response was still loading when the recording stopped"
        });
      }
    }
  }

  private pump(): void {
    while (!this.closed && this.inFlight.size < FULL_BODY_FETCH_CONCURRENCY) {
      const next = this.queue.shift();

      if (!next) {
        return;
      }

      const task = this.fetch(next)
        .catch((error: unknown) => {
          this.skip(next.response, "fetch-failed", {
            mimeType: next.mimeType,
            detail: error instanceof Error ? error.message : String(error)
          });
        })
        .finally(() => {
          this.inFlight.delete(task);
          this.pump();
        });

      this.inFlight.add(task);
    }
  }

  private async fetch(pending: PendingFetch): Promise<void> {
    const { response, rule, mimeType } = pending;
    const outcome = await this.deps.readResponseBody(response.requestId, response.sessionId);

    if (this.closed) {
      this.skip(response, "backlog", { mimeType, detail: "recording stopped" });
      return;
    }

    if (!outcome.ok) {
      this.skip(response, readFailureReason(outcome.error), { mimeType, detail: outcome.error });
      return;
    }

    const { body, base64Encoded } = outcome.value;

    if (typeof body !== "string" || body.length === 0) {
      // No bytes for a response that had some: the body went elsewhere (a service worker's own
      // fetch streams it to the page, which records it on its request).
      const hadBytes = (response.encodedDataLength ?? 0) > 0;
      this.skip(response, hadBytes ? "unavailable" : "empty", {
        mimeType,
        size: hadBytes ? response.encodedDataLength : 0,
        detail: hadBytes ? "the browser returned no body bytes" : undefined
      });
      return;
    }

    if (this.isSessionBudgetUsed()) {
      this.skip(response, "session-limit", { mimeType, limit: FULL_BODY_MAX_PER_SESSION });
      return;
    }

    const storedBytes = await this.deps.storeBody(
      response,
      { body, base64Encoded: base64Encoded === true },
      rule,
      mimeType
    );

    this.storedCount += 1;
    this.storedBytes += storedBytes;
  }

  private isSessionBudgetUsed(): boolean {
    return (
      this.storedCount >= FULL_BODY_MAX_PER_SESSION ||
      this.storedBytes >= FULL_BODY_MAX_BYTES_PER_SESSION
    );
  }

  private skip(response: FinishedResponse, reason: BodySkipReason, detail: SkipDetail = {}): void {
    this.deps.emitSkip({
      reqId: response.requestId,
      side: "response",
      reason,
      ...withoutUndefined(detail)
    });
  }
}

function requestKey(response: Pick<FinishedResponse, "requestId" | "sessionId">): string {
  return `${response.sessionId ?? "root"}:${response.requestId}`;
}

/** Whether the policy's "textual bodies" covers this response at all (binary and bodyless do not). */
function isTextualResponse(meta: RequestMetaEntry, mimeType: string | undefined): boolean {
  if (meta.resourceType && NON_TEXT_RESOURCE_TYPES.has(meta.resourceType)) {
    return false;
  }

  const status = meta.status;

  if (
    status !== undefined &&
    (BODYLESS_STATUSES.has(status) || (status >= 300 && status < 400 && status !== 304))
  ) {
    return false;
  }

  return mimeType ? isTextualMimeType(mimeType) : isLikelyTextualResourceType(meta.resourceType);
}

/** Skip reason of a failed CDP body read. */
export function readFailureReason(error: string): BodySkipReason {
  if (UNAVAILABLE_POST_DATA_PATTERN.test(error)) {
    return "unavailable";
  }

  return NOT_RETAINED_ERROR_PATTERN.test(error) ? "not-retained" : "fetch-failed";
}

/** Whether a `Network.requestWillBeSent` carries a body CDP did not inline (e.g. a `Blob`). */
export function needsRequestPostData(payload: Record<string, unknown> | null): boolean {
  const request = payload?.request;

  if (!request || typeof request !== "object") {
    return false;
  }

  const row = request as Record<string, unknown>;
  return (
    row.hasPostData === true &&
    typeof row.postData !== "string" &&
    !(Array.isArray(row.postDataEntries) && row.postDataEntries.length > 0)
  );
}

/**
 * The request event with the body read through `Network.getRequestPostData`, or with
 * `request.postDataSkipped` saying why it is missing.
 */
export async function completeRequestPostData(
  payload: Record<string, unknown>,
  readPostData: () => Promise<CdpReadOutcome<{ postData?: string }>>
): Promise<Record<string, unknown>> {
  const request = payload.request as Record<string, unknown>;
  const outcome = await readPostData();

  if (outcome.ok && typeof outcome.value.postData === "string") {
    return { ...payload, request: { ...request, postData: outcome.value.postData } };
  }

  const reason = outcome.ok ? "unavailable" : readFailureReason(outcome.error);
  return { ...payload, request: { ...request, postDataSkipped: reason } };
}

function withoutUndefined(detail: SkipDetail): SkipDetail {
  return Object.fromEntries(
    Object.entries(detail).filter(([, value]) => value !== undefined)
  ) as SkipDetail;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
