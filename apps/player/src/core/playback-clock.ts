/** Arrow keys and the transport step buttons move the playhead by this much. */
export const PLAYBACK_STEP_MS = 1_000;
/** Shift + arrow. */
export const PLAYBACK_LARGE_STEP_MS = 5_000;
/** `,` / `.` move by one frame of a 30 fps tab recording. */
export const PLAYBACK_FRAME_MS = 1_000 / 30;
/** Speed multiplier inside idle stretches when "skip idle" is on. */
export const IDLE_SPEEDUP = 8;
/** Only gaps between events at least this long count as idle. */
export const IDLE_GAP_MIN_MS = 2_000;
/** Playback keeps the normal speed this close to an event. */
export const IDLE_GAP_MARGIN_MS = 500;

export type PlaybackBounds = {
  minMono: number;
  maxMono: number;
};

/** A stretch without events where "skip idle" speeds playback up. */
export type IdleGap = {
  startMono: number;
  endMono: number;
};

export type AdvancePlayheadInput = {
  playheadMono: number;
  elapsedMs: number;
  rate: number;
  bounds: PlaybackBounds;
  /** Sorted idle gaps; `null` or empty plays everything at `rate`. */
  idleGaps?: readonly IdleGap[] | null;
};

export type AdvancePlayheadResult = {
  playheadMono: number;
  /** The playhead reached the end of the session. */
  ended: boolean;
};

export function clampMono(mono: number, bounds: PlaybackBounds): number {
  if (!Number.isFinite(mono)) {
    return bounds.minMono;
  }

  return Math.min(bounds.maxMono, Math.max(bounds.minMono, mono));
}

/** Where playback starts: from the beginning when the playhead is already at the end. */
export function resolvePlayStart(playheadMono: number, bounds: PlaybackBounds): number {
  return playheadMono >= bounds.maxMono - 1 ? bounds.minMono : clampMono(playheadMono, bounds);
}

/**
 * Idle gaps between consecutive event times (sorted ascending), shrunk by the margin on both sides
 * so playback slows down before the next event.
 */
export function findIdleGaps(
  sortedMonos: readonly number[],
  minGapMs: number = IDLE_GAP_MIN_MS,
  marginMs: number = IDLE_GAP_MARGIN_MS
): IdleGap[] {
  const gaps: IdleGap[] = [];

  for (let index = 1; index < sortedMonos.length; index += 1) {
    const previous = sortedMonos[index - 1];
    const next = sortedMonos[index];

    if (previous === undefined || next === undefined || next - previous < minGapMs) {
      continue;
    }

    const startMono = previous + marginMs;
    const endMono = next - marginMs;

    if (endMono > startMono) {
      gaps.push({ startMono, endMono });
    }
  }

  return gaps;
}

/** The idle gap containing `mono`, by binary search over sorted gaps. */
export function findIdleGapAt(gaps: readonly IdleGap[], mono: number): IdleGap | null {
  let low = 0;
  let high = gaps.length - 1;

  while (low <= high) {
    const middle = (low + high) >> 1;
    const gap = gaps[middle];

    if (!gap) {
      return null;
    }

    if (mono < gap.startMono) {
      high = middle - 1;
    } else if (mono >= gap.endMono) {
      low = middle + 1;
    } else {
      return gap;
    }
  }

  return null;
}

/**
 * One playback frame: moves the playhead by the elapsed wall time times the rate. Inside an idle
 * gap the rate is multiplied by `IDLE_SPEEDUP`, but never past the end of the gap.
 */
export function advancePlayhead(input: AdvancePlayheadInput): AdvancePlayheadResult {
  const { bounds } = input;
  const elapsed = Math.max(0, Number.isFinite(input.elapsedMs) ? input.elapsedMs : 0);
  const rate = Number.isFinite(input.rate) && input.rate > 0 ? input.rate : 1;
  const start = clampMono(input.playheadMono, bounds);
  const gap = input.idleGaps ? findIdleGapAt(input.idleGaps, start) : null;
  const step = elapsed * rate * (gap ? IDLE_SPEEDUP : 1);
  const candidate = gap ? Math.min(start + step, gap.endMono) : start + step;
  const playheadMono = clampMono(candidate, bounds);

  return {
    playheadMono,
    ended: playheadMono >= bounds.maxMono - 0.001
  };
}

/** `requestAnimationFrame`-like scheduler; injectable for tests. */
export type FrameScheduler = {
  request(callback: (timestamp: number) => void): number;
  cancel(handle: number): void;
};

export type FrameLoop = {
  start(): void;
  stop(): void;
  isRunning(): boolean;
};

/**
 * Calls `onFrame` with the wall time since the previous frame (0 on the first one) until it
 * returns `false` or `stop()` is called.
 */
export function createFrameLoop(
  scheduler: FrameScheduler,
  onFrame: (elapsedMs: number) => boolean
): FrameLoop {
  let handle: number | null = null;
  let lastTimestamp: number | null = null;

  const tick = (timestamp: number): void => {
    const elapsed = lastTimestamp === null ? 0 : Math.max(0, timestamp - lastTimestamp);
    lastTimestamp = timestamp;
    handle = null;

    if (onFrame(elapsed) && lastTimestamp !== null) {
      handle = scheduler.request(tick);
    }
  };

  return {
    start(): void {
      if (handle !== null) {
        return;
      }

      lastTimestamp = null;
      handle = scheduler.request(tick);
    },
    stop(): void {
      if (handle !== null) {
        scheduler.cancel(handle);
      }

      handle = null;
      lastTimestamp = null;
    },
    isRunning(): boolean {
      return handle !== null;
    }
  };
}
