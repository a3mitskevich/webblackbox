import { describe, expect, it } from "vitest";

import {
  advancePlayhead,
  clampMono,
  createFrameLoop,
  findIdleGapAt,
  findIdleGaps,
  IDLE_SPEEDUP,
  resolvePlayStart,
  type FrameScheduler
} from "./playback-clock.js";

const BOUNDS = { minMono: 1_000, maxMono: 11_000 };

describe("clampMono / resolvePlayStart", () => {
  it("keeps the playhead inside the session", () => {
    expect(clampMono(500, BOUNDS)).toBe(1_000);
    expect(clampMono(20_000, BOUNDS)).toBe(11_000);
    expect(clampMono(Number.NaN, BOUNDS)).toBe(1_000);
    expect(clampMono(4_000, BOUNDS)).toBe(4_000);
  });

  it("restarts from the beginning at the end", () => {
    expect(resolvePlayStart(11_000, BOUNDS)).toBe(1_000);
    expect(resolvePlayStart(10_999.5, BOUNDS)).toBe(1_000);
    expect(resolvePlayStart(5_000, BOUNDS)).toBe(5_000);
  });
});

describe("idle gaps", () => {
  it("finds long gaps between events, shrunk by the margin", () => {
    expect(findIdleGaps([0, 100, 5_000, 5_400, 9_000], 2_000, 500)).toEqual([
      { startMono: 600, endMono: 4_500 },
      { startMono: 5_900, endMono: 8_500 }
    ]);
    expect(findIdleGaps([0, 1_000], 1_000, 500)).toEqual([]);
    expect(findIdleGaps([])).toEqual([]);
  });

  it("looks gaps up by time", () => {
    const gaps = findIdleGaps([0, 5_000, 10_000], 2_000, 500);

    expect(findIdleGapAt(gaps, 3_000)).toEqual({ startMono: 500, endMono: 4_500 });
    expect(findIdleGapAt(gaps, 7_000)).toEqual({ startMono: 5_500, endMono: 9_500 });
    expect(findIdleGapAt(gaps, 5_000)).toBeNull();
    expect(findIdleGapAt(gaps, 4_500)).toBeNull();
    expect(findIdleGapAt([], 1)).toBeNull();
  });
});

describe("advancePlayhead", () => {
  it("moves by elapsed time × rate and stops at the end", () => {
    expect(
      advancePlayhead({ playheadMono: 1_000, elapsedMs: 16, rate: 2, bounds: BOUNDS })
    ).toEqual({ playheadMono: 1_032, ended: false });
    expect(
      advancePlayhead({ playheadMono: 10_990, elapsedMs: 100, rate: 1, bounds: BOUNDS })
    ).toEqual({ playheadMono: 11_000, ended: true });
  });

  it("ignores invalid rates and elapsed times", () => {
    expect(
      advancePlayhead({ playheadMono: 2_000, elapsedMs: -5, rate: Number.NaN, bounds: BOUNDS })
        .playheadMono
    ).toBe(2_000);
    expect(
      advancePlayhead({ playheadMono: 2_000, elapsedMs: 10, rate: 0, bounds: BOUNDS }).playheadMono
    ).toBe(2_010);
  });

  it("speeds up inside idle gaps but never past their end", () => {
    const idleGaps = [{ startMono: 2_000, endMono: 6_000 }];

    expect(
      advancePlayhead({ playheadMono: 3_000, elapsedMs: 100, rate: 1, bounds: BOUNDS, idleGaps })
        .playheadMono
    ).toBe(3_000 + 100 * IDLE_SPEEDUP);
    expect(
      advancePlayhead({ playheadMono: 5_900, elapsedMs: 100, rate: 1, bounds: BOUNDS, idleGaps })
        .playheadMono
    ).toBe(6_000);
    expect(
      advancePlayhead({ playheadMono: 7_000, elapsedMs: 100, rate: 1, bounds: BOUNDS, idleGaps })
        .playheadMono
    ).toBe(7_100);
  });
});

describe("createFrameLoop", () => {
  function fakeScheduler() {
    const queue = new Map<number, (timestamp: number) => void>();
    let next = 1;
    const scheduler: FrameScheduler = {
      request(callback) {
        const handle = next;
        next += 1;
        queue.set(handle, callback);
        return handle;
      },
      cancel(handle) {
        queue.delete(handle);
      }
    };
    const flush = (timestamp: number): void => {
      const callbacks = [...queue.values()];
      queue.clear();
      callbacks.forEach((callback) => callback(timestamp));
    };
    return { scheduler, flush, pending: () => queue.size };
  }

  it("reports elapsed time per frame until the callback stops it", () => {
    const { scheduler, flush, pending } = fakeScheduler();
    const elapsed: number[] = [];
    const loop = createFrameLoop(scheduler, (ms) => {
      elapsed.push(ms);
      return elapsed.length < 3;
    });

    loop.start();
    loop.start();
    expect(pending()).toBe(1);
    flush(100);
    flush(116);
    flush(150);
    expect(elapsed).toEqual([0, 16, 34]);
    expect(loop.isRunning()).toBe(false);
  });

  it("stops on request, also from inside a frame", () => {
    const { scheduler, flush, pending } = fakeScheduler();
    const loop = createFrameLoop(scheduler, () => {
      loop.stop();
      return true;
    });

    loop.start();
    flush(10);
    expect(pending()).toBe(0);

    const other = createFrameLoop(scheduler, () => true);
    other.start();
    other.stop();
    expect(pending()).toBe(0);
    expect(other.isRunning()).toBe(false);
  });
});
