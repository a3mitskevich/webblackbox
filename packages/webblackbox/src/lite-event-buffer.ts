import type { RawRecorderEvent } from "@webblackbox/recorder";

import type { LiteCaptureState } from "./types.js";

const PRE_RECORDING_BUFFER_MAX = 400;
const EVENT_BUFFER_FLUSH_DELAY_MS = 180;
export const EVENT_BUFFER_FORCE_FLUSH_SIZE = 120;
const EVENT_BUFFER_EMIT_CHUNK_SIZE = 80;
export const EVENT_BUFFER_SOFT_LIMIT = 420;
export const EVENT_BUFFER_HARD_LIMIT = 1_200;
const PERF_LOG_FLAG = "__WEBBLACKBOX_PERF__";

const LOW_PRIORITY_RAW_TYPES = new Set([
  "mousemove",
  "wheel",
  "hover",
  "scroll",
  "mutation",
  "rrweb",
  "vitals",
  "longtask",
  "snapshot",
  "screenshot"
]);

type EventBufferHost = {
  emitBatch: (events: RawRecorderEvent[]) => void;
  mode: () => LiteCaptureState["mode"];
};

/**
 * Raw events on their way to the host: emitted in chunks on a short timer, with low-priority
 * events shed under backpressure, plus the network/console/error events seen before Start.
 */
export class LiteEventBuffer {
  private readonly eventBuffer: RawRecorderEvent[] = [];
  private readonly preRecordingBuffer: RawRecorderEvent[] = [];
  private flushTimer = 0;
  private droppedLowPriorityEvents = 0;

  public constructor(private readonly host: EventBufferHost) {}

  private get mode(): LiteCaptureState["mode"] {
    return this.host.mode();
  }

  /** Events waiting to be emitted. */
  public get length(): number {
    return this.eventBuffer.length;
  }

  /** Before Start: keeps the events that explain how the page got where the recording starts. */
  public bufferBeforeRecording(event: RawRecorderEvent): void {
    if (shouldBufferBeforeRecording(event)) {
      this.preRecordingBuffer.push(event);

      if (this.preRecordingBuffer.length > PRE_RECORDING_BUFFER_MAX) {
        this.preRecordingBuffer.splice(
          0,
          this.preRecordingBuffer.length - PRE_RECORDING_BUFFER_MAX
        );
      }
    }
  }

  /** While recording: queues the event unless backpressure sheds it. */
  public enqueue(event: RawRecorderEvent): void {
    if (this.shouldDropEventForBackpressure(event)) {
      return;
    }

    this.eventBuffer.push(event);
    this.scheduleBufferedFlush(
      this.eventBuffer.length >= EVENT_BUFFER_FORCE_FLUSH_SIZE ? 0 : EVENT_BUFFER_FLUSH_DELAY_MS
    );
  }

  public flushPreRecordingBuffer(): void {
    if (this.preRecordingBuffer.length === 0) {
      return;
    }

    this.eventBuffer.push(...this.preRecordingBuffer.splice(0, this.preRecordingBuffer.length));
    this.scheduleBufferedFlush(0);
  }

  private flushEvents(): void {
    if (this.flushTimer > 0) {
      clearTimeout(this.flushTimer);
      this.flushTimer = 0;
    }

    if (this.eventBuffer.length === 0) {
      return;
    }

    const events = this.eventBuffer.splice(0, EVENT_BUFFER_EMIT_CHUNK_SIZE);

    if (events.length > 0) {
      this.host.emitBatch(events);
    }

    if (this.eventBuffer.length > 0) {
      this.scheduleBufferedFlush(0);
    }
  }

  private scheduleBufferedFlush(delayMs: number): void {
    if (this.flushTimer > 0) {
      if (delayMs > 0) {
        return;
      }

      clearTimeout(this.flushTimer);
      this.flushTimer = 0;
    }

    this.flushTimer = window.setTimeout(
      () => {
        this.flushEvents();
      },
      Math.max(0, delayMs)
    );
  }

  public drainBufferedEvents(): void {
    if (this.flushTimer > 0) {
      clearTimeout(this.flushTimer);
      this.flushTimer = 0;
    }

    if (this.eventBuffer.length === 0) {
      return;
    }

    while (this.eventBuffer.length > 0) {
      const events = this.eventBuffer.splice(0, EVENT_BUFFER_EMIT_CHUNK_SIZE);

      if (events.length === 0) {
        break;
      }

      this.host.emitBatch(events);
    }
  }

  private shouldDropEventForBackpressure(event: RawRecorderEvent): boolean {
    const buffered = this.eventBuffer.length;

    if (buffered < EVENT_BUFFER_SOFT_LIMIT) {
      return false;
    }

    if (!LOW_PRIORITY_RAW_TYPES.has(event.rawType)) {
      return false;
    }

    if (buffered < EVENT_BUFFER_SOFT_LIMIT) {
      return false;
    }

    if (buffered >= EVENT_BUFFER_HARD_LIMIT || this.mode === "full") {
      if (buffered >= EVENT_BUFFER_HARD_LIMIT && this.mode !== "full") {
        this.dropBufferedLowPriorityEvents(buffered - EVENT_BUFFER_SOFT_LIMIT + 1);
        this.scheduleBufferedFlush(0);
      }

      this.droppedLowPriorityEvents += 1;

      if (isPerfLoggingEnabled() && this.droppedLowPriorityEvents % 200 === 0) {
        console.info("[WebBlackbox][perf] dropped low-priority events", {
          mode: this.mode,
          dropped: this.droppedLowPriorityEvents,
          buffered,
          rawType: event.rawType
        });
      }

      return true;
    }

    return false;
  }

  private dropBufferedLowPriorityEvents(targetDropCount: number): void {
    if (targetDropCount <= 0 || this.eventBuffer.length === 0) {
      return;
    }

    let dropped = 0;
    const retained: RawRecorderEvent[] = [];

    for (const event of this.eventBuffer) {
      if (dropped < targetDropCount && LOW_PRIORITY_RAW_TYPES.has(event.rawType)) {
        dropped += 1;
        continue;
      }

      retained.push(event);
    }

    if (dropped === 0) {
      return;
    }

    this.eventBuffer.length = 0;
    this.eventBuffer.push(...retained);
    this.droppedLowPriorityEvents += dropped;
  }

  public cancelScheduledFlush(): void {
    if (this.flushTimer > 0) {
      clearTimeout(this.flushTimer);
      this.flushTimer = 0;
    }
  }

  public clear(): void {
    this.eventBuffer.length = 0;
    this.preRecordingBuffer.length = 0;
  }
}

function isPerfLoggingEnabled(): boolean {
  const flags = window as unknown as Record<string, unknown>;
  return flags[PERF_LOG_FLAG] === true;
}

function shouldBufferBeforeRecording(event: RawRecorderEvent): boolean {
  if (event.source !== "content") {
    return false;
  }

  return (
    event.rawType === "console" ||
    event.rawType === "fetch" ||
    event.rawType === "xhr" ||
    event.rawType === "networkBody" ||
    event.rawType === "fetchError" ||
    event.rawType === "pageError" ||
    event.rawType === "unhandledrejection" ||
    event.rawType === "resourceError"
  );
}
