import { monotonicTime } from "./lite-capture-config.js";
import type { LiteCaptureState } from "./types.js";

export const LONG_TASK_PRESSURE_THRESHOLD_MS = 40;
export const RAF_PRESSURE_GAP_MS = 34;

type PerformanceCaptureHost = {
  mode: () => LiteCaptureState["mode"];
  emit: (rawType: string, payload: Record<string, unknown>) => void;
  /** A long task of the lite page (capture backs off for a while). */
  onLongTask: (duration: number) => void;
  /** A frame gap of at least {@link RAF_PRESSURE_GAP_MS} on a lite page. */
  onFrameGap: (frameGap: number) => void;
  addCleanup: (cleanup: () => void) => void;
};

/** Long-task, frame-gap and web-vitals observers of the top-level frame. */
export function installPerformanceObservers(host: PerformanceCaptureHost): void {
  if (typeof PerformanceObserver === "undefined") {
    return;
  }

  try {
    // Long tasks and vitals are page-only signals (CDP has no stream for them): kept in full mode.
    const longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (host.mode() !== "full" && entry.duration >= LONG_TASK_PRESSURE_THRESHOLD_MS) {
          host.onLongTask(entry.duration);
        }

        host.emit("longtask", {
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration
        });
      }
    });

    longTaskObserver.observe({ entryTypes: ["longtask"] });
    host.addCleanup(() => longTaskObserver.disconnect());
  } catch {
    void 0;
  }

  // Frame-gap pressure only tunes lite capture; full mode does not need the rAF loop.
  if (host.mode() !== "full" && typeof window.requestAnimationFrame === "function") {
    let lastFrameMono = monotonicTime();
    let rafHandle = 0;

    const tick = () => {
      const nowMono = monotonicTime();
      const frameGap = nowMono - lastFrameMono;
      lastFrameMono = nowMono;

      if (frameGap >= RAF_PRESSURE_GAP_MS) {
        host.onFrameGap(frameGap);
      }

      rafHandle = window.requestAnimationFrame(tick);
    };

    rafHandle = window.requestAnimationFrame(tick);
    host.addCleanup(() => {
      if (rafHandle > 0) {
        window.cancelAnimationFrame(rafHandle);
      }
    });
  }

  const vitalTypes: Array<{ type: string; rawType: string }> = [
    { type: "largest-contentful-paint", rawType: "vitals" },
    { type: "layout-shift", rawType: "vitals" },
    { type: "first-input", rawType: "vitals" }
  ];

  for (const item of vitalTypes) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          host.emit(item.rawType, {
            metric: item.type,
            name: entry.name,
            startTime: entry.startTime,
            duration: entry.duration,
            value: (entry as PerformanceEntry & { value?: number }).value
          });
        }
      });

      observer.observe({ type: item.type, buffered: true });
      host.addCleanup(() => observer.disconnect());
    } catch {
      void 0;
    }
  }
}
