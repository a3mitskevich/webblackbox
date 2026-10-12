import type { BodySkipReason, NetworkBodySkippedPayload } from "@webblackbox/protocol";

import {
  decodeBase64,
  isLikelyTextualResourceType,
  isTextualMimeType,
  normalizeMimeType,
  ruleSkipReason,
  type BodyCaptureRule
} from "./body-capture-utils.js";
import { isBrowserInternalUrl } from "@webblackbox/recorder";

import { LargeBodyStreams, type BodyHeadStream, type StartStream } from "./full-body-stream.js";
import {
  CHROME_DEFAULT_RESOURCE_BUFFER_BYTES,
  resolveNetworkEnableParams
} from "./network-buffers.js";
import type { RequestMetaEntry } from "./request-meta.js";

/** Bodies read from CDP at the same time; more wait in the queue. */
export const FULL_BODY_FETCH_CONCURRENCY = 4;
/** Bodies waiting to be read; past this a finished response is recorded as `backlog`. */
export const FULL_BODY_FETCH_MAX_PENDING = 1_000;
/** Bodies kept per session; later ones are recorded as `session-limit`. */
export const FULL_BODY_MAX_PER_SESSION = 20_000;
/** Body bytes kept per session (after the per-body limit); later ones are `session-limit`. */
export const FULL_BODY_MAX_BYTES_PER_SESSION = 512 * 1024 * 1024;
/**
 * A body whose encoded size exceeds this many times the per-body limit is a large read: the read
 * holds the whole body to keep its start, so large reads run one at a time.
 */
export const FULL_BODY_LARGE_READ_FACTOR = 2;

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
  /** The `Content-Length` the response declared (encoded bytes), when it declared one. */
  contentLength?: number;
  meta: RequestMetaEntry | undefined;
  /**
   * The response arrived without a `requestWillBeSent`: the request was in flight when the
   * capture began, so the browser kept no body for it.
   */
  startedBeforeCapture?: boolean;
};

/**
 * A body read whole through `Network.getResponseBody`, or the start of one streamed through
 * `Network.streamResourceContent` (`totalBytes` decoded bytes in all).
 */
export type ReadBody =
  { body: string; base64Encoded: boolean } | { head: Uint8Array; totalBytes: number };

export type FullBodyCaptureDeps = {
  /** Whether the session's policy asks for bodies at all (full mode, `body-allowlist`). */
  isEnabled: () => boolean;
  resolveRule: (url: string, mimeType: string | undefined) => BodyCaptureRule;
  readResponseBody: (
    requestId: string,
    sessionId: string | undefined
  ) => Promise<CdpReadOutcome<ResponseBodyRead>>;
  /**
   * Starts `Network.streamResourceContent` for a response still loading. Without it, responses
   * too large to read whole are recorded `too-large`.
   */
  streamResponseBody?: StartStream;
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
  large: boolean;
  /** Decoded bytes the response received, when counted while it loaded. */
  receivedBytes: number | undefined;
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

  private largeReadInFlight = false;

  /** Responses seen but not finished yet, by request key (session + request id). */
  private readonly awaitingFinish = new Map<string, FinishedResponse>();

  /** Requests sent while capturing that have no response yet, by request key. */
  private readonly awaitingResponse = new Set<string>();

  /** Responses whose body is kept, while they load; too large ones stream their start. */
  private readonly streams: LargeBodyStreams;

  private storedCount = 0;

  private storedBytes = 0;

  private closed = false;

  public constructor(private readonly deps: FullBodyCaptureDeps) {
    this.streams = new LargeBodyStreams(
      deps.streamResponseBody,
      decodeBase64,
      FULL_BODY_MAX_AWAITING_FINISH
    );
  }

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

    if (!startedBeforeCapture) {
      this.trackBody(key, response);
    }
  }

  /** Bytes of a response arrived; a streamed response also carries them as `data`. */
  public onDataReceived(
    requestId: string,
    sessionId: string | undefined,
    dataLength: number,
    data: string | undefined
  ): void {
    this.streams.onData(requestKey({ requestId, sessionId }), dataLength, data);
  }

  /** The request failed or was cancelled: there is no body to keep. */
  public onLoadingFailed(requestId: string, sessionId: string | undefined): void {
    const key = requestKey({ requestId, sessionId });
    this.awaitingFinish.delete(key);
    this.awaitingResponse.delete(key);
    this.streams.forget(key);
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
    const tracked = this.streams.take(key);
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

    const rule = tracked?.rule ?? this.deps.resolveRule(meta.url ?? "", mimeType);

    if (!rule.enabled) {
      this.skip(response, ruleSkipReason(rule, mimeType), { mimeType });
      return;
    }

    const stream = tracked?.stream;

    if (stream) {
      this.run(response, mimeType, () => this.storeStream(response, stream, rule, mimeType));
      return;
    }

    // The browser keeps no body this large: its start could only have been streamed.
    if (
      response.encodedDataLength !== undefined &&
      response.encodedDataLength > keptBodyBytes(rule)
    ) {
      this.skip(response, "too-large", {
        mimeType,
        size: response.encodedDataLength,
        limit: rule.maxBytes,
        detail: tracked?.notStreamed ?? NOT_KEPT_DETAIL
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

    // A compressed body decodes past its encoded size: the decoded bytes counted while it loaded
    // are what the read holds.
    const readBytes = Math.max(response.encodedDataLength ?? 0, tracked?.receivedBytes ?? 0);

    this.queue.push({
      response,
      rule,
      mimeType,
      large: readBytes > rule.maxBytes * FULL_BODY_LARGE_READ_FACTOR,
      receivedBytes: tracked?.receivedBytes
    });
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
    this.streams.clear();

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

  /**
   * Follows a response whose body the policy keeps while it loads, so it can stream the start of
   * one too large to read whole. Event streams never finish and are left out.
   */
  private trackBody(key: string, response: FinishedResponse): void {
    const { meta } = response;
    const mimeType = normalizeMimeType(meta?.mimeType);

    if (
      !meta ||
      !isTextualResponse(meta, mimeType) ||
      isOutsideBodyCapture(meta.url ?? "") ||
      isEventStream(meta, mimeType)
    ) {
      return;
    }

    const rule = this.deps.resolveRule(meta.url ?? "", mimeType);

    if (rule.enabled) {
      this.streams.track(key, response, rule, keptBodyBytes(rule));
    }
  }

  private pump(): void {
    while (!this.closed && this.inFlight.size < FULL_BODY_FETCH_CONCURRENCY) {
      const next = this.queue[0];

      // A large read waits for the one in flight (the queue keeps its order).
      if (!next || (next.large && this.largeReadInFlight)) {
        return;
      }

      this.queue.shift();

      if (next.large) {
        this.largeReadInFlight = true;
      }

      this.run(next.response, next.mimeType, async () => {
        try {
          await this.fetch(next);
        } finally {
          if (next.large) {
            this.largeReadInFlight = false;
          }
        }
      });
    }
  }

  /** Runs a body task in the pool: drain waits for it, a thrown error is recorded. */
  private run(
    response: FinishedResponse,
    mimeType: string | undefined,
    work: () => Promise<void>
  ): void {
    const task = work()
      .catch((error: unknown) => {
        this.skip(response, "fetch-failed", {
          mimeType,
          detail: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        this.inFlight.delete(task);
        this.pump();
      });

    this.inFlight.add(task);
  }

  /** Stores the streamed start of a body, truncated at the limit, or records why it failed. */
  private async storeStream(
    response: FinishedResponse,
    stream: BodyHeadStream,
    rule: BodyCaptureRule,
    mimeType: string | undefined
  ): Promise<void> {
    const outcome = await stream.result();

    if (this.closed) {
      this.skip(response, "backlog", { mimeType, detail: "recording stopped" });
      return;
    }

    if (!outcome.ok) {
      this.skip(response, "too-large", {
        mimeType,
        size: response.encodedDataLength,
        limit: rule.maxBytes,
        detail: `streaming its start failed: ${outcome.error}`
      });
      return;
    }

    if (outcome.head.byteLength === 0) {
      this.skip(response, "unavailable", {
        mimeType,
        detail: "the browser streamed no body bytes"
      });
      return;
    }

    if (this.isSessionBudgetUsed()) {
      this.skip(response, "session-limit", { mimeType, limit: FULL_BODY_MAX_PER_SESSION });
      return;
    }

    const storedBytes = await this.deps.storeBody(
      response,
      { head: outcome.head, totalBytes: outcome.totalBytes },
      rule,
      mimeType
    );

    this.storedCount += 1;
    this.storedBytes += storedBytes;
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

      // Counted while it loaded: past what the browser keeps for one response, it was never kept.
      if (
        reason === "not-retained" &&
        pending.receivedBytes !== undefined &&
        pending.receivedBytes > keptBodyBytes(pending.rule)
      ) {
        this.skip(response, "too-large", {
          mimeType,
          size: pending.receivedBytes,
          limit: rule.maxBytes,
          detail: NOT_KEPT_DETAIL
        });
        return;
      }

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

const NOT_KEPT_DETAIL = "larger than the browser keeps for one response";

/** Bytes the browser keeps of one response (`Network.enable` per-resource buffer). */
function keptBodyBytes(rule: BodyCaptureRule): number {
  return (
    resolveNetworkEnableParams(rule.maxBytes).maxResourceBufferSize ??
    CHROME_DEFAULT_RESOURCE_BUFFER_BYTES
  );
}

function isEventStream(meta: RequestMetaEntry, mimeType: string | undefined): boolean {
  return mimeType === "text/event-stream" || meta.resourceType === "EventSource";
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
