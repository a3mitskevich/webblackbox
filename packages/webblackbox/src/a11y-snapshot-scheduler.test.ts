import type { A11ySnapshotTrigger } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import { A11Y_SNAPSHOT_MAX_WAIT_MS, A11ySnapshotScheduler } from "./a11y-snapshot-scheduler.js";

type Taken = { trigger: A11ySnapshotTrigger; dropped: number; at: number };

/** A scheduler on a manual clock. */
function setup(options: { maxPerMinute?: number; capture?: boolean } = {}) {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const taken: Taken[] = [];
  const scheduler = new A11ySnapshotScheduler({
    capture: (trigger, dropped) => {
      taken.push({ trigger, dropped, at: now });
      return options.capture ?? true;
    },
    now: () => now,
    setTimer: (callback, delayMs) => {
      const id = nextTimer++;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    maxPerMinute: options.maxPerMinute
  });
  const advance = (ms: number) => {
    const until = now + ms;

    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort((left, right) => left[1].at - right[1].at)[0];

      if (!due) {
        break;
      }

      timers.delete(due[0]);
      now = due[1].at;
      due[1].callback();
    }

    now = until;
  };

  return { scheduler, taken, advance };
}

describe("A11ySnapshotScheduler", () => {
  it("waits for the page to settle after an action", () => {
    const { scheduler, taken, advance } = setup();
    scheduler.trigger({ kind: "action", rawType: "click" });

    advance(600);
    expect(taken).toHaveLength(0);
    advance(100);
    expect(taken).toEqual([
      { trigger: { kind: "action", rawType: "click", delayMs: 700 }, dropped: 0, at: 700 }
    ]);
  });

  it("folds triggers into the pending snapshot, named by the first one", () => {
    const { scheduler, taken, advance } = setup();
    scheduler.trigger({ kind: "action", rawType: "click" });
    advance(500);
    scheduler.trigger({ kind: "error", rawType: "pageError" });
    scheduler.trigger({ kind: "action", rawType: "keydown" });
    advance(5_000);

    expect(taken).toEqual([
      {
        trigger: { kind: "action", rawType: "click", coalesced: 2, delayMs: 1_200 },
        dropped: 0,
        at: 1_200
      }
    ]);
  });

  it("does not wait longer than the max wait on a busy page", () => {
    const { scheduler, taken, advance } = setup();
    scheduler.trigger({ kind: "navigation" });

    for (let index = 0; index < 20; index += 1) {
      advance(400);
      scheduler.trigger({ kind: "action" });
    }

    expect(taken[0]?.at).toBe(A11Y_SNAPSHOT_MAX_WAIT_MS);
  });

  it("caps snapshots per minute and reports dropped triggers on the next one", () => {
    const { scheduler, taken, advance } = setup({ maxPerMinute: 2 });

    for (let index = 0; index < 4; index += 1) {
      scheduler.trigger({ kind: "error" });
      advance(1_000);
    }

    expect(taken).toHaveLength(2);
    advance(60_000);
    scheduler.trigger({ kind: "action" });
    advance(1_000);

    expect(taken).toHaveLength(3);
    expect(taken[2]).toMatchObject({ trigger: { kind: "action" }, dropped: 2 });
  });

  it("takes the final snapshot at once, over the cap, folding a pending trigger", () => {
    const { scheduler, taken, advance } = setup({ maxPerMinute: 1 });
    scheduler.trigger({ kind: "action" });
    advance(1_000);
    scheduler.trigger({ kind: "action" });
    scheduler.flushNow({ kind: "stop" });

    expect(taken.map((entry) => entry.trigger)).toEqual([
      { kind: "action", delayMs: 700 },
      { kind: "stop" }
    ]);
    expect(taken[1]?.dropped).toBe(1);

    scheduler.trigger({ kind: "error" });
    expect(scheduler.hasPending()).toBe(false);
  });

  it("folds a pending trigger into the stop snapshot", () => {
    const { scheduler, taken } = setup();
    scheduler.trigger({ kind: "action" });
    scheduler.flushNow({ kind: "stop" });

    expect(taken.map((entry) => entry.trigger)).toEqual([{ kind: "stop", coalesced: 1 }]);
    expect(scheduler.hasPending()).toBe(false);
  });

  it("does not count snapshots that recorded nothing", () => {
    const { scheduler, taken, advance } = setup({ maxPerMinute: 1, capture: false });
    scheduler.trigger({ kind: "action" });
    advance(1_000);
    scheduler.trigger({ kind: "action" });
    advance(1_000);

    expect(taken).toHaveLength(2);
  });

  it("cancels the pending snapshot", () => {
    const { scheduler, taken, advance } = setup();
    scheduler.trigger({ kind: "action" });
    scheduler.cancel();
    advance(5_000);

    expect(taken).toHaveLength(0);
  });
});
