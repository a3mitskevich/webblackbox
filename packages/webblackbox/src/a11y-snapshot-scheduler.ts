import {
  A11Y_SNAPSHOT_LIMITS,
  type A11ySnapshotTrigger,
  type A11ySnapshotTriggerKind
} from "@webblackbox/protocol";

/** How long the page may settle after a trigger before the snapshot (ms). */
export const A11Y_SNAPSHOT_SETTLE_MS: Readonly<Record<A11ySnapshotTriggerKind, number>> = {
  // Long enough for a validation message or a response to show.
  action: 700,
  error: 300,
  navigation: 1_200,
  marker: 0,
  stop: 0
};
/** Longest wait from the first pending trigger: a busy page still gets its snapshot. */
export const A11Y_SNAPSHOT_MAX_WAIT_MS = 3_000;
const MINUTE_MS = 60_000;

export type A11ySnapshotSchedulerDeps = {
  /** Takes the snapshot; returns false when nothing was recorded (no document, not recording). */
  capture: (trigger: A11ySnapshotTrigger, droppedTriggers: number) => boolean;
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (timer: number) => void;
  maxPerMinute?: number;
};

type Pending = {
  trigger: A11ySnapshotTrigger;
  firstAt: number;
  dueAt: number;
  timer: number;
  coalesced: number;
};

/**
 * When accessibility snapshots are taken: each trigger waits for the page to settle, triggers
 * that arrive meanwhile fold into the pending snapshot (the first trigger names it), and at most
 * `maxPerMinute` snapshots are taken per rolling minute. Triggers over the cap are counted and
 * reported on the next snapshot, never silently lost.
 */
export class A11ySnapshotScheduler {
  private pending: Pending | null = null;
  private readonly takenAt: number[] = [];
  private droppedTriggers = 0;

  public constructor(private readonly deps: A11ySnapshotSchedulerDeps) {}

  public trigger(trigger: A11ySnapshotTrigger): void {
    const now = this.deps.now();
    const settleMs = A11Y_SNAPSHOT_SETTLE_MS[trigger.kind];

    if (this.pending) {
      const pending = this.pending;
      pending.coalesced += 1;
      const dueAt = Math.min(
        Math.max(pending.dueAt, now + settleMs),
        pending.firstAt + A11Y_SNAPSHOT_MAX_WAIT_MS
      );

      if (dueAt !== pending.dueAt) {
        this.deps.clearTimer(pending.timer);
        pending.dueAt = dueAt;
        pending.timer = this.deps.setTimer(() => this.fire(), Math.max(0, dueAt - now));
      }

      return;
    }

    if (!this.hasBudget(now)) {
      this.droppedTriggers += 1;
      return;
    }

    this.pending = {
      trigger,
      firstAt: now,
      dueAt: now + settleMs,
      coalesced: 0,
      timer: this.deps.setTimer(() => this.fire(), settleMs)
    };
  }

  /**
   * Takes a snapshot now (the recording stops): a pending trigger is folded in. The final
   * snapshot ignores the per-minute cap.
   */
  public flushNow(trigger: A11ySnapshotTrigger): void {
    const pending = this.pending;
    this.cancel();
    this.take({
      ...trigger,
      ...(pending ? { coalesced: pending.coalesced + 1 } : {})
    });
  }

  /** Drops the pending snapshot (the recording ended or the agent is disposed). */
  public cancel(): void {
    if (this.pending) {
      this.deps.clearTimer(this.pending.timer);
      this.pending = null;
    }
  }

  public hasPending(): boolean {
    return this.pending !== null;
  }

  private fire(): void {
    const pending = this.pending;
    this.pending = null;

    if (!pending) {
      return;
    }

    this.take({
      ...pending.trigger,
      ...(pending.coalesced > 0 ? { coalesced: pending.coalesced } : {}),
      delayMs: Math.max(0, Math.round(this.deps.now() - pending.firstAt))
    });
  }

  private take(trigger: A11ySnapshotTrigger): void {
    if (this.deps.capture(trigger, this.droppedTriggers)) {
      this.takenAt.push(this.deps.now());
      this.droppedTriggers = 0;
    }
  }

  private hasBudget(now: number): boolean {
    while (this.takenAt.length > 0 && now - this.takenAt[0]! >= MINUTE_MS) {
      this.takenAt.shift();
    }

    return this.takenAt.length < (this.deps.maxPerMinute ?? A11Y_SNAPSHOT_LIMITS.maxPerMinute);
  }
}
