import "uplot/dist/uPlot.min.css";

import type uPlot from "uplot";
import { useEffect, useId, useRef, useState } from "react";

export type PerfChartSeries = {
  label: string;
  /** A CSS token from styles/next.css, e.g. `--accent`. */
  colorToken: string;
  values: readonly number[];
  /** Bars instead of a line (long tasks). */
  bars?: boolean;
  /** The second y axis (right). */
  scale?: "y" | "y2";
};

type PerfChartProps = {
  /** Bucket starts, seconds from the session start. */
  offsets: readonly number[];
  series: readonly PerfChartSeries[];
  height: number;
  /** Seconds from the session start; drawn as the playhead line. */
  playhead: number;
  onSeek: (seconds: number) => void;
  label: string;
  /** The legend label of the time axis. */
  timeLabel: string;
  /** A text alternative for the canvas (what the series show), read by screen readers. */
  summary: string;
  /** Shown when uPlot fails to load or to draw. */
  unavailableText: string;
  /** Bumped when colours change (theme), so the chart re-reads its tokens. */
  themeKey: string;
  testId: string;
};

let canvasSupport: boolean | null = null;

/** jsdom has no canvas; the chart then renders as an empty, labelled box. */
function supportsCanvas(): boolean {
  if (canvasSupport === null) {
    try {
      canvasSupport =
        typeof navigator !== "undefined" &&
        !navigator.userAgent.includes("jsdom") &&
        document.createElement("canvas").getContext("2d") !== null;
    } catch {
      canvasSupport = false;
    }
  }

  return canvasSupport;
}

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

/**
 * A uPlot time series (canvas: thousands of points stay smooth) with the playhead drawn on it;
 * clicking the plot seeks. uPlot owns the chart's DOM inside the container; its stylesheet ships
 * as a file with this chunk (no injected styles).
 */
export function PerfChart({
  offsets,
  series,
  height,
  playhead,
  onSeek,
  label,
  timeLabel,
  summary,
  unavailableText,
  themeKey,
  testId
}: PerfChartProps) {
  const summaryId = useId();
  const [isUnavailable, setUnavailable] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const playheadRef = useRef(playhead);
  const onSeekRef = useRef(onSeek);

  onSeekRef.current = onSeek;

  useEffect(() => {
    const container = containerRef.current;

    if (!container || !supportsCanvas()) {
      return undefined;
    }

    let isCurrent = true;
    let cleanup = (): void => undefined;

    // uPlot reads matchMedia at import, so it loads with the first chart (and never in jsdom).
    import("uplot")
      .then(({ default: UPlot }) => {
        if (isCurrent) {
          cleanup = mountPlot(UPlot, container);
          // A later redraw (new data, theme) recovers from an earlier failed load.
          setUnavailable(false);
        }
      })
      .catch((error: unknown) => {
        // A failed chunk load or a uPlot error leaves an explained box, not a silent blank.
        console.error("Perf chart unavailable", error);

        if (isCurrent) {
          setUnavailable(true);
        }
      });

    return () => {
      isCurrent = false;
      cleanup();
    };
  }, [offsets, series, height, themeKey, timeLabel]);

  function mountPlot(UPlot: typeof uPlot, container: HTMLDivElement): () => void {
    const ink = token("--ink-3");
    const grid = token("--line-2");
    const playheadColor = token("--playhead");
    const bars = UPlot.paths.bars?.({ size: [0.9, 6] });
    const options: uPlot.Options = {
      width: Math.max(200, container.clientWidth),
      height,
      legend: { show: true, live: true },
      cursor: { drag: { x: false, y: false }, points: { show: false } },
      scales: { x: { time: false }, y: { range: (_u, _min, max) => [0, Math.max(1, max)] } },
      axes: [
        {
          stroke: ink,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid },
          values: (_u, splits) => splits.map((value) => `${value}s`)
        },
        { stroke: ink, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, size: 44 },
        ...(series.some((entry) => entry.scale === "y2")
          ? [{ scale: "y2", side: 1 as const, stroke: ink, grid: { show: false }, size: 60 }]
          : [])
      ],
      series: [
        { label: timeLabel, value: (_u, value) => (value === null ? "—" : `${value.toFixed(2)}s`) },
        ...series.map((entry) => {
          const color = token(entry.colorToken);

          return {
            label: entry.label,
            stroke: color,
            width: entry.bars ? 0 : 1.5,
            fill: entry.bars ? color : `${color}22`,
            scale: entry.scale ?? "y",
            ...(entry.bars && bars ? { paths: bars } : {}),
            points: { show: false }
          };
        })
      ],
      hooks: {
        draw: [
          (plot) => {
            const x = plot.valToPos(playheadRef.current, "x", true);
            const { ctx, bbox } = plot;
            ctx.save();
            ctx.strokeStyle = playheadColor;
            ctx.lineWidth = Math.max(1, devicePixelRatio);
            ctx.beginPath();
            ctx.moveTo(x, bbox.top);
            ctx.lineTo(x, bbox.top + bbox.height);
            ctx.stroke();
            ctx.restore();
          }
        ]
      }
    };
    const plot = new UPlot(
      options,
      [Array.from(offsets), ...series.map((entry) => Array.from(entry.values))],
      container
    );
    const seek = (): void => {
      const left = plot.cursor.left;

      if (typeof left === "number" && left >= 0) {
        onSeekRef.current(Math.max(0, plot.posToVal(left, "x")));
      }
    };
    plot.over.addEventListener("click", seek);
    const resize = new ResizeObserver(() => {
      plot.setSize({ width: Math.max(200, container.clientWidth), height });
    });
    resize.observe(container);
    plotRef.current = plot;

    return () => {
      resize.disconnect();
      plot.over.removeEventListener("click", seek);
      plot.destroy();
      plotRef.current = null;
    };
  }

  useEffect(() => {
    playheadRef.current = playhead;
    plotRef.current?.redraw(false, false);
  }, [playhead]);

  return (
    <figure
      className="pf-chart"
      aria-label={label}
      aria-describedby={summaryId}
      data-testid={testId}
      data-unavailable={isUnavailable || undefined}
    >
      <figcaption id={summaryId} className="visually-hidden">
        {summary}
      </figcaption>
      {isUnavailable ? (
        <p className="pf-none" role="status" data-testid={`${testId}-unavailable`}>
          {unavailableText}
        </p>
      ) : null}
      {/* Stays mounted, so a redraw can retry after a failed load. */}
      <div
        ref={containerRef}
        className="pf-plot"
        hidden={isUnavailable}
        style={{ minHeight: height }}
      />
    </figure>
  );
}
