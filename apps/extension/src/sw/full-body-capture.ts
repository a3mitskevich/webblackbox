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

/**
 * Responses waiting for `loadingFinished`, and requests waiting for their response; the oldest
 * are forgotten past this.
 */
export const FULL_BODY_MAX_AWAITING_FINISH = 5_000;

/** Statuses that never carry a body. 304 is kept: CDP serves the cached body for it. */
const BODYLESS_STATUSES = new Set([101, 204, 205]);
/**
 * CDP errors meaning the browser no longer holds the body: evicted from its network buffer
 * (about 200 MB by default) or never kept ("No data found for resource with given identifier").
 */
const NOT_RETAINED_ERROR_PATTERN = /evicted|no (resource|data)\b.*\bfound/i;
/** CDP error for a request body the browser cannot expose (e.g. a streamed body). */
const UNAVAILABLE_POST_DATA_PATTERN = /no post data available/i;
/** A `data:` URL: its body is the URL itself. */
const DATA_URL_PATTERN = /^data:/i;

export type CdpReadOutcome<TResult> = { ok: true; value: TResult } | { ok: false; error: string };

export type ResponseBodyRead = { body?: string; base64Encoded?: boolean };

export type FinishedResponse = {
  requestId: string;
  sessionId?: string;
  encodedDataLength?: number;
  meta: RequestMetaEntry | undefined;
  /**
   * The response arrived without a `requestWillBeSent`: the request was in flight when the
   * capture began, so the browser kept no body for it.
   */
  startedBeforeCapture?: boolean;
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

  /** Requests sent while capturing that have no response yet, by request key. */
  private readonly awaitingResponse = new Set<string>();

  private storedCount = 0;

  private storedBytes = 0;

  private closed = false;

  public constructor(private readonly deps: FullBodyCaptureDeps) {}

  /** A request was sent (or redirected) while capturing: the browser keeps its body. */
  public onRequestWillBeSent(requestId: string, sessionId: string | undefined): void {
    if (this.closed || !this.deps.isEnabled()) {
      return;
    }

    const key = requestKey({ requestId, sessionId });
    this.awaitingResponse.delete(key);
    forgetOldestPast(this.awaitingResponse, FULL_BODY_MAX_AWAITING_FINISH);
    this.awaitingResponse.add(key);
  }

  /** A response arrived; its body is decided when it finishes (or when the recording stops). */
  public onResponseReceived(response: FinishedResponse): void {
    if (this.closed || !this.deps.isEnabled()) {
      return;
    }

    const key = requestKey(response);
    const startedBeforeCapture = !this.awaitingResponse.delete(key);
    this.awaitingFinish.delete(key);
    forgetOldestPast(this.awaitingFinish, FULL_BODY_MAX_AWAITING_FINISH);
    this.awaitingFinish.set(key, { ...response, startedBeforeCapture });
  }

  /** The request failed or was cancelled: there is no body to keep. */
  public onLoadingFailed(requestId: string, sessionId: string | undefined): void {
    const key = requestKey({ requestId, sessionId });
    this.awaitingFinish.delete(key);
    this.awaitingResponse.delete(key);
  }

  public onLoadingFinished(finishedResponse: FinishedResponse): void {
    const key = requestKey(finishedResponse);
    const received = this.awaitingFinish.get(key);
    // Metadata kept at response time covers entries the shared metadata map already expired.
    const response = {
      ...finishedResponse,
      meta: finishedResponse.meta ?? received?.meta,
      startedBeforeCapture: finishedResponse.startedBeforeCapture ?? received?.startedBeforeCapture
    };
    this.awaitingFinish.delete(key);
    this.awaitingResponse.delete(key);

    if (this.closed || !this.deps.isEnabled()) {
      return;
    }

    const { meta } = response;

    // No response event (e.g. `blob:` URLs, or events a child session sent before it was
    // primed): the archive holds no textual response for it, so there is no body to account for.
    if (!meta) {
      return;
    }

    const mimeType = normalizeMimeType(meta.mimeType);

    if (!isTextualResponse(meta, mimeType) || isOutsideBodyCapture(meta.url ?? "")) {
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
    this.awaitingResponse.clear();

    if (!this.deps.isEnabled()) {
      return;
    }

    for (const response of unfinished) {
      const mimeType = normalizeMimeType(response.meta?.mimeType);

      if (
        response.meta &&
        isTextualResponse(response.meta, mimeType) &&
        !isOutsideBodyCapture(response.meta.url ?? "")
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
      const reason = readFailureReason(outcome.error);
      this.skip(
        response,
        reason === "not-retained" && response.startedBeforeCapture
          ? "started-before-capture"
          : reason,
        { mimeType, detail: outcome.error }
      );
      return;
    }

    const { body, base64Encoded } = outcome.value;

    if (typeof body !== "string" || body.length === 0) {
      // No bytes for a response whose body had some: the body went elsewhere (a service
      // worker's own fetch streams it to the page, which records it on its request).
      const bodyBytes = Math.max(
        0,
        (response.encodedDataLength ?? 0) - (response.meta?.headerBytes ?? 0)
      );
      const hadBytes = response.meta?.headerBytes !== undefined && bodyBytes > 0;
      this.skip(response, hadBytes ? "unavailable" : "empty", {
        mimeType,
        size: hadBytes ? bodyBytes : 0,
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

/** Drops the oldest entries (insertion order) so one more fits under `limit`. */
function forgetOldestPast(entries: Map<string, unknown> | Set<string>, limit: number): void {
  for (const key of entries.keys()) {
    if (entries.size < limit) {
      return;
    }

    entries.delete(key);
  }
}

/**
 * Responses with no body to read: extension and browser-internal resources are not the app's
 * traffic (the recorder drops them), and a `data:` URL carries its body in the URL itself.
 */
function isOutsideBodyCapture(url: string): boolean {
  return isBrowserInternalUrl(url) || DATA_URL_PATTERN.test(url);
}

/**
 * Whether the policy's "textual bodies" covers this response at all (binary and bodyless do not).
 * The MIME type decides when there is one, whatever loaded it: an SVG image is text.
 */
function isTextualResponse(meta: RequestMetaEntry, mimeType: string | undefined): boolean {
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
