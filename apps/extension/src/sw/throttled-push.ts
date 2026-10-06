export type ThrottledPush = {
  /** Pushes now, or once at the end of the interval when the last push was too recent. */
  schedule(): void;
  /** Pushes now and drops a scheduled push: the state just sent is the latest. */
  now(): void;
};

/**
 * Leading + trailing throttle for broadcasts driven by every recorded event (counters, errors),
 * so an error storm sends at most one push per interval while the last state still goes out.
 */
export function createThrottledPush(
  push: () => void,
  intervalMs: number,
  clock: () => number = Date.now
): ThrottledPush {
  let lastPushAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const pushNow = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }

    lastPushAt = clock();
    push();
  };

  return {
    schedule: () => {
      if (timer !== null) {
        return;
      }

      const waitMs = lastPushAt + intervalMs - clock();

      if (waitMs <= 0) {
        pushNow();
        return;
      }

      timer = setTimeout(pushNow, waitMs);
    },
    now: pushNow
  };
}
