import { useEffect, useState } from "react";

export type Output<T> =
  | { status: "pending" }
  | { status: "ready"; value: T }
  | { status: "error"; message: string };

/**
 * Runs `callback` once the browser has painted the current frame (a task queued from the next
 * animation frame), so a pending state rendered now is on screen before a long job blocks the
 * main thread. Returns a cancel function.
 */
export function afterNextPaint(callback: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (typeof requestAnimationFrame !== "function") {
    timer = setTimeout(callback, 0);
    return () => clearTimeout(timer);
  }

  const frame = requestAnimationFrame(() => {
    timer = setTimeout(callback, 0);
  });

  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
}

/**
 * Runs a generator (sync or async) whenever `job` changes and keeps only the latest answer, so a
 * slow mock script for an old range never replaces the one for the new range. The job starts
 * after "Generating…" has painted: a large archive freezes the tab for a moment, never silently.
 */
export function useGenerated<T>(job: () => T | Promise<T>): Output<T> {
  const [output, setOutput] = useState<{ job: () => T | Promise<T>; output: Output<T> } | null>(
    null
  );

  useEffect(() => {
    let current = true;

    const cancel = afterNextPaint(() => {
      Promise.resolve()
        .then(job)
        .then(
          (value) => current && setOutput({ job, output: { status: "ready", value } }),
          (error: unknown) =>
            current &&
            setOutput({
              job,
              output: {
                status: "error",
                message: error instanceof Error ? error.message : String(error)
              }
            })
        );
    });

    return () => {
      current = false;
      cancel();
    };
  }, [job]);

  return output && output.job === job ? output.output : { status: "pending" };
}
