export type ConcurrencyLimiter = {
  /** Runs `task` once a slot is free; queued tasks start in FIFO order. */
  run<TValue>(task: () => Promise<TValue>): Promise<TValue>;
};

/**
 * Caps how many tasks run at once. Used to bound concurrent archive-analysis workers, whose
 * per-worker heap and buffer limits would otherwise multiply with parallel uploads.
 */
export function createConcurrencyLimiter(maxConcurrent: number): ConcurrencyLimiter {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new TypeError(
      `maxConcurrent must be a positive integer, received ${String(maxConcurrent)}.`
    );
  }

  const waiting: Array<() => void> = [];
  let active = 0;

  const acquire = (): Promise<void> => {
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  };

  const release = (): void => {
    const next = waiting.shift();

    if (next) {
      // Hand the slot straight to the next task; `active` stays the same.
      next();
      return;
    }

    active -= 1;
  };

  return {
    async run<TValue>(task: () => Promise<TValue>): Promise<TValue> {
      await acquire();

      try {
        return await task();
      } finally {
        release();
      }
    }
  };
}
