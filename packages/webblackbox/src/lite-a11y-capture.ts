import type { A11ySnapshotTrigger, CapturePolicy } from "@webblackbox/protocol";

import { captureA11ySnapshot } from "./a11y-snapshot.js";
import { A11ySnapshotScheduler } from "./a11y-snapshot-scheduler.js";

/** Raw type of the page-side accessibility snapshot (`dom.a11y.snapshot`). */
export const A11Y_SNAPSHOT_RAW_TYPE = "a11ySnapshot";

const ACTION_RAW_TYPES = new Set(["click", "dblclick", "submit", "contextmenu", "auxclick"]);
const ACTION_KEYS = new Set(["Enter", "NumpadEnter"]);
const ERROR_RAW_TYPES = new Set(["pageError", "unhandledrejection"]);

/** What the capture agent provides to the accessibility snapshots. */
export type LiteA11yCaptureHost = {
  policy: () => CapturePolicy;
  isRecording: () => boolean;
  isTopLevelFrame: () => boolean;
  emit: (rawType: string, payload: Record<string, unknown>) => void;
  listen: (target: EventTarget, type: string, listener: (event: Event) => void) => void;
};

/**
 * Accessibility snapshots of the top frame at key moments: after an action (click, submit,
 * Enter), an error, a navigation (a new document, history or hash change), a marker, and at
 * stop. Every profile that records the DOM records them; the content rules of the profile apply.
 */
export class LiteA11yCapture {
  private readonly scheduler: A11ySnapshotScheduler;
  /** The URL route changes are measured against; null until the recording started here. */
  private lastHref: string | null = null;

  public constructor(private readonly host: LiteA11yCaptureHost) {
    this.scheduler = new A11ySnapshotScheduler({
      capture: (trigger, droppedTriggers) => this.capture(trigger, droppedTriggers),
      now: () => performance.now(),
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: (timer) => window.clearTimeout(timer)
    });
  }

  /** Recording started in this document: its state once it settled, and route changes. */
  public start(): void {
    if (!this.isEnabled()) {
      return;
    }

    this.lastHref = location.href;
    this.host.listen(window, "popstate", () => this.noteRouteChange("popstate"));
    this.host.listen(window, "hashchange", () => this.noteRouteChange("hashchange"));
    this.scheduler.trigger({ kind: "navigation", rawType: "document" });
  }

  /** Watches the recorded raw events for triggers. */
  public observe(rawType: string, payload: Record<string, unknown>): void {
    if (rawType === A11Y_SNAPSHOT_RAW_TYPE || !this.isEnabled()) {
      return;
    }

    const trigger = toTrigger(rawType, payload);

    if (trigger) {
      this.scheduler.trigger(trigger);
    }

    // A history API route change shows up as the events it causes (mutations, requests).
    if (this.lastHref !== null && location.href !== this.lastHref) {
      this.noteRouteChange("url-change");
    }
  }

  /** A trigger the host saw elsewhere (Full mode: an error the debugger reported). */
  public request(trigger: A11ySnapshotTrigger): void {
    if (this.isEnabled()) {
      this.scheduler.trigger(trigger);
    }
  }

  /** The last state of the page, taken synchronously before the recording stops. */
  public stop(): void {
    this.lastHref = null;

    if (this.isEnabled()) {
      this.scheduler.flushNow({ kind: "stop" });
      return;
    }

    this.scheduler.cancel();
  }

  public dispose(): void {
    this.lastHref = null;
    this.scheduler.cancel();
  }

  private noteRouteChange(rawType: string): void {
    this.lastHref = location.href;
    this.scheduler.trigger({ kind: "navigation", rawType });
  }

  private isEnabled(): boolean {
    return (
      this.host.isTopLevelFrame() &&
      this.host.isRecording() &&
      this.host.policy().categories.dom !== "off"
    );
  }

  private capture(trigger: A11ySnapshotTrigger, droppedTriggers: number): boolean {
    if (!this.isEnabled()) {
      return false;
    }

    try {
      const snapshot = captureA11ySnapshot({
        policy: this.host.policy(),
        trigger,
        droppedTriggers
      });

      if (!snapshot) {
        return false;
      }

      this.host.emit(A11Y_SNAPSHOT_RAW_TYPE, snapshot);
      return true;
    } catch (error) {
      // A page that breaks the walk (a throwing getter, a detached frame) costs its snapshot
      // only; capture goes on.
      console.warn("[WebBlackbox] accessibility snapshot failed", error);
      return false;
    }
  }
}

function toTrigger(rawType: string, payload: Record<string, unknown>): A11ySnapshotTrigger | null {
  if (ACTION_RAW_TYPES.has(rawType)) {
    return { kind: "action", rawType };
  }

  if (rawType === "keydown") {
    return typeof payload.key === "string" && ACTION_KEYS.has(payload.key)
      ? { kind: "action", rawType }
      : null;
  }

  if (ERROR_RAW_TYPES.has(rawType) || (rawType === "console" && payload.level === "error")) {
    return { kind: "error", rawType };
  }

  if (rawType === "marker") {
    return { kind: "marker", rawType };
  }

  return null;
}
