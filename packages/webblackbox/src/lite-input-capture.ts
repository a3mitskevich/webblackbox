import type { CapturePolicy } from "@webblackbox/protocol";

import { monotonicTime } from "./lite-capture-config.js";
import { createKeydownPayload } from "./lite-keystrokes.js";
import { toFastTargetPayload, type LiteTargetPayloads } from "./lite-target-payload.js";
import { notePasswordField, readCapturableInputValue } from "./input-value-policy.js";
import { readGeometry, type PointerCaptureController } from "./pointer-capture.js";
import { round } from "./pointer-target.js";
import type { LiteCaptureSampling, LiteCaptureState } from "./types.js";

const SCROLL_BURST_DEBOUNCE_MS = 140;
const POINTERMOVE_SUPPRESS_AFTER_SCROLL_MS = 220;

const INPUT_OPTIONS_TRUE: AddEventListenerOptions = {
  capture: true
};

const PASSIVE_INPUT_OPTIONS_TRUE: AddEventListenerOptions = {
  capture: true,
  passive: true
};

/** What the capture agent provides to its input listeners. */
export type InputCaptureHost = {
  pointerCapture: PointerCaptureController;
  targets: LiteTargetPayloads;
  mode(): LiteCaptureState["mode"];
  sampling(): LiteCaptureSampling;
  capturePolicy(): CapturePolicy;
  listen<TEvent extends Event>(
    target: EventTarget,
    type: string,
    listener: (event: TEvent) => void,
    options?: AddEventListenerOptions
  ): void;
  emit(rawType: string, payload: Record<string, unknown>, mono?: number): void;
  markUserActivity(): void;
  trackPointer(x: number, y: number): void;
  recordEditableInteraction(target: EventTarget | null): void;
  recordScrollPressure(): void;
  shouldSuppressPointerMoveCapture(): boolean;
  emitMarker(message: string): void;
  emitViewportSnapshot(reason: string): void;
  emitLifecycleEvent(rawType: string, payload: Record<string, unknown>): void;
};

/**
 * Clicks, keys, inputs, focus, scroll and pointer moves of the page, with scroll and pointer-move
 * sampling (the trailing scroll position is emitted once a scroll burst settles).
 */
export class LiteInputCapture {
  private trailingScrollTimer = 0;
  private lastScrollTime = 0;
  private lastPointerTime = Number.NEGATIVE_INFINITY;
  private scrollBurstActiveUntilMono = Number.NEGATIVE_INFINITY;
  private pendingScrollPayload: {
    target: Record<string, unknown>;
    scrollX: number;
    scrollY: number;
  } | null = null;
  private lastEmittedScrollPosition: { scrollX: number; scrollY: number } | null = null;

  public constructor(private readonly host: InputCaptureHost) {}

  /** Input, scroll, pointer and page lifecycle listeners (removed by the agent's cleanups). */
  public install(): void {
    this.host.pointerCapture.install();

    this.host.listen(
      document,
      "wheel",
      (event: WheelEvent) => {
        this.host.markUserActivity();

        if (this.host.mode() === "full") {
          return;
        }

        if (Math.abs(event.deltaX) + Math.abs(event.deltaY) <= 0) {
          return;
        }

        this.host.recordScrollPressure();
      },
      PASSIVE_INPUT_OPTIONS_TRUE
    );

    this.host.listen(
      document,
      "click",
      (event: MouseEvent) => {
        this.host.markUserActivity();
        this.host.trackPointer(event.clientX, event.clientY);
        const mono = monotonicTime();
        this.host.emit("click", this.createClickPayload(event), mono);
        this.host.pointerCapture.onClick(mono);
      },
      INPUT_OPTIONS_TRUE
    );

    this.host.listen(
      document,
      "dblclick",
      (event: MouseEvent) => {
        this.host.markUserActivity();
        this.host.trackPointer(event.clientX, event.clientY);
        this.host.emit("dblclick", this.createClickPayload(event));
      },
      INPUT_OPTIONS_TRUE
    );

    this.host.listen(
      document,
      "keydown",
      (event: KeyboardEvent) => {
        this.host.markUserActivity();
        this.host.recordEditableInteraction(event.target);
        notePasswordField(event.target);
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "m") {
          this.host.emitMarker("Keyboard marker");
        }

        this.host.emit(
          "keydown",
          createKeydownPayload(event, this.host.capturePolicy(), (target) =>
            this.host.targets.resolveTargetPayload(target, "fast")
          )
        );
      },
      INPUT_OPTIONS_TRUE
    );

    this.host.listen(
      document,
      "input",
      (event: Event) => {
        this.host.markUserActivity();
        const target = event.target;

        if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
          return;
        }

        this.host.recordEditableInteraction(target);

        const value = readCapturableInputValue(target, this.host.capturePolicy());

        this.host.emit("input", {
          inputType: target.type,
          length: target.value.length,
          ...(value === undefined ? { valueRedacted: true } : { value }),
          target: this.host.targets.resolveTargetPayload(target, "input")
        });
      },
      INPUT_OPTIONS_TRUE
    );

    this.host.listen(
      document,
      "change",
      (event: Event) => {
        this.host.markUserActivity();
        this.host.recordEditableInteraction(event.target);
        this.host.emit("input", {
          kind: "change",
          target: this.host.targets.resolveTargetPayload(event.target, "fast")
        });
      },
      INPUT_OPTIONS_TRUE
    );

    this.host.listen(
      document,
      "focus",
      (event: FocusEvent) => {
        this.host.markUserActivity();
        notePasswordField(event.target);
        this.host.emit("focus", {
          target: this.host.targets.resolveTargetPayload(event.target, "fast")
        });
      },
      INPUT_OPTIONS_TRUE
    );

    this.host.listen(
      document,
      "blur",
      (event: FocusEvent) => {
        this.host.markUserActivity();
        this.host.emit("blur", {
          target: this.host.targets.resolveTargetPayload(event.target, "fast")
        });
      },
      INPUT_OPTIONS_TRUE
    );

    this.host.listen(
      document,
      "submit",
      (event: Event) => {
        this.host.markUserActivity();
        this.host.emit("submit", {
          target: this.host.targets.resolveTargetPayload(event.target, "fast")
        });
      },
      INPUT_OPTIONS_TRUE
    );

    this.host.listen(
      document,
      "scroll",
      (event: Event) => {
        this.host.markUserActivity();
        if (this.host.mode() === "full") {
          return;
        }

        this.host.recordScrollPressure();

        const now = performance.now();
        const scrollGapMs = Math.max(
          16,
          Math.round(1000 / Math.max(1, this.host.sampling().scrollHz))
        );

        if (now - this.lastScrollTime < scrollGapMs) {
          this.queueTrailingScrollEvent(event);
          return;
        }

        this.lastScrollTime = now;
        this.scrollBurstActiveUntilMono =
          monotonicTime() + Math.max(POINTERMOVE_SUPPRESS_AFTER_SCROLL_MS, scrollGapMs);

        const payload = {
          target: toFastTargetPayload(event.target, this.host.targets.selectorSalt()),
          scrollX: window.scrollX,
          scrollY: window.scrollY
        };

        this.pendingScrollPayload = payload;
        this.emitQueuedScrollEvent(payload);
        this.scheduleTrailingScrollFlush(scrollGapMs);
      },
      PASSIVE_INPUT_OPTIONS_TRUE
    );

    this.host.listen(
      document,
      "pointermove",
      (event: PointerEvent) => {
        this.host.pointerCapture.onPointerMove(event);
        const now = performance.now();
        const pointerGapMs = Math.max(
          16,
          Math.round(1000 / Math.max(1, this.host.sampling().mousemoveHz))
        );

        // Full mode keeps page-side work minimal: nothing runs between samples, even while
        // capture is suppressed, so the sample clock advances before the pressure check.
        if (this.host.mode() === "full") {
          if (now - this.lastPointerTime < pointerGapMs) {
            return;
          }

          this.lastPointerTime = now;
        }

        this.host.markUserActivity();
        this.host.trackPointer(event.clientX, event.clientY);

        if (this.host.shouldSuppressPointerMoveCapture()) {
          return;
        }

        if (this.host.mode() !== "full") {
          if (now - this.lastPointerTime < pointerGapMs) {
            return;
          }

          this.lastPointerTime = now;
        }

        this.host.emit("mousemove", {
          x: round(event.clientX),
          y: round(event.clientY),
          target: toFastTargetPayload(event.target, this.host.targets.selectorSalt())
        });
      },
      PASSIVE_INPUT_OPTIONS_TRUE
    );

    this.host.listen(window, "resize", () => {
      this.host.markUserActivity();
      this.host.emitViewportSnapshot("resize");
    });

    this.host.listen(document, "visibilitychange", () => {
      this.host.markUserActivity();
      this.host.emitLifecycleEvent("visibilitychange", {
        state: document.visibilityState
      });
    });
  }

  private createClickPayload(event: MouseEvent): Record<string, unknown> {
    return {
      x: round(event.clientX),
      y: round(event.clientY),
      pageX: round(event.pageX),
      pageY: round(event.pageY),
      ...readGeometry(),
      button: event.button,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      target: this.host.targets.createPointerTargetPayload(event.target, "rich")
    };
  }

  private queueTrailingScrollEvent(event: Event): void {
    this.pendingScrollPayload = {
      target: toFastTargetPayload(event.target, this.host.targets.selectorSalt()),
      scrollX: window.scrollX,
      scrollY: window.scrollY
    };
    this.scrollBurstActiveUntilMono = monotonicTime() + POINTERMOVE_SUPPRESS_AFTER_SCROLL_MS;
    this.scheduleTrailingScrollFlush(SCROLL_BURST_DEBOUNCE_MS);
  }

  private scheduleTrailingScrollFlush(delayMs: number): void {
    if (this.trailingScrollTimer > 0) {
      clearTimeout(this.trailingScrollTimer);
    }

    this.trailingScrollTimer = window.setTimeout(
      () => {
        this.trailingScrollTimer = 0;
        this.flushPendingScrollEvent();
      },
      Math.max(SCROLL_BURST_DEBOUNCE_MS, delayMs)
    );
  }

  public flushPendingScrollEvent(): void {
    const pending = this.pendingScrollPayload;

    if (!pending) {
      return;
    }

    this.pendingScrollPayload = null;

    if (
      this.lastEmittedScrollPosition &&
      this.lastEmittedScrollPosition.scrollX === pending.scrollX &&
      this.lastEmittedScrollPosition.scrollY === pending.scrollY
    ) {
      return;
    }

    this.emitQueuedScrollEvent(pending);
  }

  private emitQueuedScrollEvent(payload: {
    target: Record<string, unknown>;
    scrollX: number;
    scrollY: number;
  }): void {
    this.lastEmittedScrollPosition = {
      scrollX: payload.scrollX,
      scrollY: payload.scrollY
    };

    this.host.emit("scroll", payload);
  }

  public isScrollBurstActive(): boolean {
    return monotonicTime() < this.scrollBurstActiveUntilMono;
  }

  /** Drops the trailing-scroll timer; the pending position stays until it is flushed. */
  public cancelTrailingScrollFlush(): void {
    if (this.trailingScrollTimer > 0) {
      clearTimeout(this.trailingScrollTimer);
      this.trailingScrollTimer = 0;
    }
  }
}
