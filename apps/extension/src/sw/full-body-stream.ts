import type { BodyCaptureRule } from "./body-capture-utils.js";
import type { CdpReadOutcome } from "./full-body-capture.js";

/**
 * Largest response streamed for its start; a larger one stays `too-large`. Chrome sends every
 * chunk of a streamed response, so this also bounds what one stream passes through the worker.
 */
export const FULL_BODY_STREAM_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const STREAM_LIMIT_DETAIL = `over the ${FULL_BODY_STREAM_MAX_RESPONSE_BYTES} byte limit for streaming its start`;
/** Responses streamed at the same time; more are recorded `too-large`. */
export const FULL_BODY_MAX_ACTIVE_STREAMS = 4;

/** Result of `Network.streamResourceContent`: the bytes received before streaming began. */
export type StreamStartRead = { bufferedData?: string };

export type BodyHead =
  { ok: true; head: Uint8Array; totalBytes: number } | { ok: false; error: string };

export type StartStream = (
  requestId: string,
  sessionId: string | undefined
) => Promise<CdpReadOutcome<StreamStartRead>>;

type StreamState = "starting" | "streaming" | "failed";

/**
 * The start of one response body too large to read whole, collected through
 * `Network.streamResourceContent`: the bytes Chrome buffered before streaming began, then the
 * `data` of every later `Network.dataReceived`. Only the first `maxBytes` are kept; every received
 * byte is still counted, so the stored body knows the full size.
 *
 * Chrome drops a body from its buffer once it outgrows the per-resource limit, so the buffered
 * bytes can miss the start of a body that began streaming late. Every `dataReceived` before the
 * stream started counts the bytes that must be in the buffer; when they are not, the start is lost
 * and the stream fails instead of recording a body that does not begin at its first byte.
 */
export class BodyHeadStream {
  private readonly chunks: Uint8Array[] = [];

  /** Chunks that arrived with data before the start result (kept after the buffered bytes). */
  private readonly earlyChunks: Uint8Array[] = [];

  private earlyBytes = 0;

  private keptBytes = 0;

  private receivedBytes = 0;

  private bytesBeforeStart = 0;

  private state: StreamState = "starting";

  private failure = "";

  /** Settles once the stream started or failed to. */
  public readonly started: Promise<void>;

  /**
   * `receivedBytes`: decoded bytes the response received before streaming was asked for; they
   * must come back in the buffered data.
   */
  public constructor(
    private readonly maxBytes: number,
    start: Promise<CdpReadOutcome<StreamStartRead>>,
    private readonly decodeBase64: (value: string) => Uint8Array,
    receivedBytes = 0
  ) {
    this.receivedBytes = receivedBytes;
    this.bytesBeforeStart = receivedBytes;
    this.started = start.then(
      (outcome) => this.onStarted(outcome),
      (error: unknown) => this.fail(error instanceof Error ? error.message : String(error))
    );
  }

  /** One `Network.dataReceived` of the response: `dataLength` decoded bytes, `data` once streaming. */
  public onData(dataLength: number, data: string | undefined): void {
    const length = Number.isFinite(dataLength) && dataLength > 0 ? dataLength : 0;
    this.receivedBytes += length;

    if (this.state === "failed") {
      return;
    }

    if (this.receivedBytes > FULL_BODY_STREAM_MAX_RESPONSE_BYTES) {
      this.fail(STREAM_LIMIT_DETAIL);
      return;
    }

    if (data === undefined) {
      // Received before streaming began: these bytes must come back in the buffered data.
      if (this.state === "starting") {
        this.bytesBeforeStart += length;
      }

      return;
    }

    const isStarting = this.state === "starting";

    // Chunks past the kept start are only counted: Chrome sends every chunk of the response, and
    // decoding them would cost the worker up to the streaming limit per response for nothing.
    // Before the start result, never more than the kept start, whatever the buffered bytes turn
    // out to be.
    if ((isStarting ? this.earlyBytes : this.keptBytes) >= this.maxBytes) {
      return;
    }

    const bytes = this.decodeChunk(data);

    if (!bytes) {
      return;
    }

    if (isStarting) {
      this.earlyChunks.push(bytes);
      this.earlyBytes += bytes.byteLength;
      return;
    }

    this.keep(bytes);
  }

  /** The kept start of the body once it finished loading, or why there is none. */
  public async result(): Promise<BodyHead> {
    await this.started;

    if (this.state === "failed") {
      return { ok: false, error: this.failure };
    }

    const head = new Uint8Array(this.keptBytes);
    let offset = 0;

    for (const chunk of this.chunks) {
      head.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return { ok: true, head, totalBytes: Math.max(this.receivedBytes, this.keptBytes) };
  }

  private onStarted(outcome: CdpReadOutcome<StreamStartRead>): void {
    if (!outcome.ok) {
      this.fail(outcome.error);
      return;
    }

    const buffered = outcome.value.bufferedData
      ? this.decodeChunk(outcome.value.bufferedData)
      : new Uint8Array(0);

    if (!buffered) {
      return;
    }

    if (buffered.byteLength < this.bytesBeforeStart) {
      this.fail(
        `the browser dropped the start of the body before streaming began ` +
          `(${buffered.byteLength} of ${this.bytesBeforeStart} bytes buffered)`
      );
      return;
    }

    this.state = "streaming";
    this.keep(buffered);

    for (const chunk of this.earlyChunks.splice(0, this.earlyChunks.length)) {
      this.keep(chunk);
    }
  }

  private keep(bytes: Uint8Array): void {
    const room = this.maxBytes - this.keptBytes;

    if (room <= 0 || bytes.byteLength === 0) {
      return;
    }

    const kept = bytes.byteLength > room ? bytes.slice(0, room) : bytes;
    this.chunks.push(kept);
    this.keptBytes += kept.byteLength;
  }

  private decodeChunk(data: string): Uint8Array | null {
    try {
      return this.decodeBase64(data);
    } catch (error) {
      this.fail(
        `unreadable stream data: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  private fail(reason: string): void {
    this.state = "failed";
    this.failure = reason;
    this.chunks.length = 0;
    this.earlyChunks.length = 0;
    this.keptBytes = 0;
  }
}

type TrackedResponse = {
  requestId: string;
  sessionId: string | undefined;
  rule: BodyCaptureRule;
  /** Decoded bytes received so far. */
  receivedBytes: number;
  stream?: BodyHeadStream;
  /** Why the response is not streamed although it is too large to read whole. */
  notStreamed?: string;
};

/** What a finished response leaves behind: its body rule and, when streamed, the stream. */
export type TrackedOutcome = {
  rule: BodyCaptureRule;
  /** Decoded bytes received while the response loaded (not counted once it streamed). */
  receivedBytes: number;
  stream?: BodyHeadStream;
  notStreamed?: string;
};

/**
 * Responses whose body the policy keeps, while they load: their received bytes are counted, and
 * one that declares a length the browser would not keep is streamed for its start from its
 * response on (streaming must begin before its bytes arrive, so a response without a declared
 * length cannot be streamed). At most {@link FULL_BODY_MAX_ACTIVE_STREAMS} stream at once and the
 * oldest entries are forgotten past `maxTracked`.
 */
export class LargeBodyStreams {
  private readonly tracked = new Map<string, TrackedResponse>();

  private activeStreams = 0;

  public constructor(
    private readonly start: StartStream | undefined,
    private readonly decodeBase64: (value: string) => Uint8Array,
    private readonly maxTracked: number
  ) {}

  public track(
    key: string,
    response: { requestId: string; sessionId?: string; contentLength?: number },
    rule: BodyCaptureRule,
    /** What the browser keeps of one response; a longer declared one is streamed. */
    keptBytes: number
  ): void {
    this.forget(key);
    this.forgetOldest();

    const entry: TrackedResponse = {
      requestId: response.requestId,
      sessionId: response.sessionId,
      rule,
      receivedBytes: 0
    };
    this.tracked.set(key, entry);

    if (response.contentLength !== undefined && response.contentLength > keptBytes) {
      this.startStream(entry, response.contentLength);
    }
  }

  public onData(key: string, dataLength: number, data: string | undefined): void {
    const entry = this.tracked.get(key);

    if (!entry) {
      return;
    }

    if (entry.stream) {
      entry.stream.onData(dataLength, data);
      return;
    }

    entry.receivedBytes += Number.isFinite(dataLength) && dataLength > 0 ? dataLength : 0;
  }

  /** The entry of a finished response, forgotten here. */
  public take(key: string): TrackedOutcome | undefined {
    const entry = this.tracked.get(key);

    if (!entry) {
      return undefined;
    }

    this.forget(key);
    return {
      rule: entry.rule,
      receivedBytes: entry.receivedBytes,
      ...(entry.stream ? { stream: entry.stream } : {}),
      ...(entry.notStreamed ? { notStreamed: entry.notStreamed } : {})
    };
  }

  public forget(key: string): void {
    if (this.tracked.get(key)?.stream) {
      this.activeStreams -= 1;
    }

    this.tracked.delete(key);
  }

  public clear(): void {
    this.tracked.clear();
    this.activeStreams = 0;
  }

  private startStream(entry: TrackedResponse, declaredBytes: number): void {
    if (!this.start) {
      entry.notStreamed = "streaming is not available";
      return;
    }

    if (declaredBytes > FULL_BODY_STREAM_MAX_RESPONSE_BYTES) {
      entry.notStreamed = STREAM_LIMIT_DETAIL;
      return;
    }

    if (this.activeStreams >= FULL_BODY_MAX_ACTIVE_STREAMS) {
      entry.notStreamed = "too many large responses were streaming at once";
      return;
    }

    this.activeStreams += 1;
    entry.stream = new BodyHeadStream(
      entry.rule.maxBytes,
      this.start(entry.requestId, entry.sessionId),
      this.decodeBase64,
      entry.receivedBytes
    );
  }

  private forgetOldest(): void {
    for (const key of this.tracked.keys()) {
      if (this.tracked.size < this.maxTracked) {
        return;
      }

      this.forget(key);
    }
  }
}
