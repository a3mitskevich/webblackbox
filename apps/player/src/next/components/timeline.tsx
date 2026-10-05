import { memo, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";

import {
  formatClock,
  formatOffset,
  formatRulerSeconds,
  resolveRulerStepMs
} from "../../core/format.js";
import { ratioOf } from "../../core/timeline-lanes.js";
import { useController, useI18n, usePlayerState } from "../context.js";
import type { LoadedArchive } from "../state.js";

type Lane = "errors" | "network" | "realtime";

/** Share of the track width within which a lane click picks the nearest item. */
const PICK_TOLERANCE = 0.015;

/** Position on the lanes (the label column is excluded) for a pointer over the scrub surface. */
function trackRatio(surface: HTMLElement, clientX: number): number {
  const track = surface.querySelector<HTMLElement>(".tl-track") ?? surface;
  const rect = track.getBoundingClientRect();
  return rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
}

function rulerTicks(archive: LoadedArchive): { ratio: number; ms: number; last: boolean }[] {
  const { durationMono } = archive.model;
  const step = resolveRulerStepMs(durationMono);
  const ticks: { ratio: number; ms: number; last: boolean }[] = [];

  for (let ms = 0; ms < durationMono - step * 0.4; ms += step) {
    ticks.push({ ratio: durationMono > 0 ? ms / durationMono : 0, ms, last: false });
  }

  ticks.push({ ratio: 1, ms: durationMono, last: true });
  return ticks;
}

export function Timeline() {
  const controller = useController();
  const i18n = useI18n();
  const archive = usePlayerState((state) => state.archive);
  const playheadMono = usePlayerState((state) => state.playheadMono);
  const locale = usePlayerState((state) => state.locale);
  const scrubbing = useRef(false);

  if (!archive) {
    return null;
  }

  const { view, model } = archive;
  const span = view.window;
  const ratio = ratioOf(playheadMono, span);
  const offset = playheadMono - model.minMono;
  const valueText = i18n.tn("timelineValue", {
    time: i18n.formatSeconds(offset),
    duration: i18n.formatSeconds(model.durationMono)
  });

  const seekToRatio = (value: number): void => {
    controller.seek(span.minMono + value * span.durationMono);
  };

  const pickNearest = (lane: Lane, value: number): boolean => {
    const mono = span.minMono + value * span.durationMono;
    const tolerance = span.durationMono * PICK_TOLERANCE;
    const candidates: { mono: number; pick: () => void }[] =
      lane === "errors"
        ? view.errorEvents.map((event) => ({
            mono: event.mono,
            pick: () => controller.selectEvent(event)
          }))
        : lane === "realtime"
          ? model.realtime.map((entry) => ({
              mono: entry.mono,
              pick: () => {
                const event = model.eventById.get(entry.eventId);

                if (event) {
                  controller.selectEvent(event);
                }
              }
            }))
          : model.waterfall.map((entry) => ({
              mono: entry.startMono,
              pick: () => controller.select({ kind: "request", id: entry.reqId })
            }));
    let best: { mono: number; pick: () => void } | null = null;

    for (const candidate of candidates) {
      if (!best || Math.abs(candidate.mono - mono) < Math.abs(best.mono - mono)) {
        best = candidate;
      }
    }

    if (best && Math.abs(best.mono - mono) <= tolerance) {
      best.pick();
      return true;
    }

    return false;
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) {
      return;
    }

    const surface = event.currentTarget;
    const value = trackRatio(surface, event.clientX);
    const lane = (event.target as HTMLElement).closest<HTMLElement>("[data-lane]")?.dataset.lane as
      | Lane
      | undefined;

    surface.focus();

    if (lane && pickNearest(lane, value)) {
      return;
    }

    scrubbing.current = true;
    surface.setPointerCapture(event.pointerId);
    seekToRatio(value);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (scrubbing.current) {
      seekToRatio(trackRatio(event.currentTarget, event.clientX));
    }
  };

  const stopScrubbing = (event: PointerEvent<HTMLDivElement>): void => {
    scrubbing.current = false;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  // Arrow keys, Home and End are global shortcuts; Page keys move by 10 % of the session.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      controller.seek(playheadMono + (event.key === "PageUp" ? 1 : -1) * span.durationMono * 0.1);
    }
  };

  const style = { "--p": ratio.toFixed(4) } as CSSProperties;

  return (
    <div className="tl" data-testid="timeline">
      <div className="tl-body" style={style}>
        <ChaptersRow archive={archive} />
        <ActionsRow archive={archive} />
        <div
          className="scrub"
          role="slider"
          tabIndex={0}
          aria-label={i18n.tn("timelineLabel")}
          aria-valuemin={0}
          aria-valuemax={Math.round(model.durationMono) / 1_000}
          aria-valuenow={Math.round(offset) / 1_000}
          aria-valuetext={valueText}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={stopScrubbing}
          onPointerCancel={stopScrubbing}
          onKeyDown={handleKeyDown}
          data-testid="scrubber"
        >
          <ScrubLanes archive={archive} />
        </div>
        <i
          className="playhead"
          data-t={formatClock(offset, locale)}
          aria-hidden="true"
          data-testid="playhead"
        />
      </div>
      <p className="hints">{i18n.tn("keyHints")}</p>
    </div>
  );
}

type LaneProps = { archive: LoadedArchive };

// The lanes only change with the archive, the locale or the selection; memo keeps them out of the
// per-frame re-render that the playhead causes while playing.
const ChaptersRow = memo(function ChaptersRow({ archive }: LaneProps) {
  const controller = useController();
  const i18n = useI18n();
  const locale = usePlayerState((state) => state.locale);
  const { view, model } = archive;
  const span = view.window;

  return (
    <div className="tl-row">
      <span className="tl-label">{i18n.tn("routesLane")}</span>
      <div className="chapters" data-testid="chapters">
        {view.chapters.map((chapter) => (
          <button
            key={`${chapter.startMono}-${chapter.label}`}
            type="button"
            className={chapter.isErrorRoute ? "chapter bad" : "chapter"}
            style={{
              left: `${(ratioOf(chapter.startMono, span) * 100).toFixed(3)}%`,
              width: `${(
                (ratioOf(chapter.endMono, span) - ratioOf(chapter.startMono, span)) *
                100
              ).toFixed(3)}%`
            }}
            title={`${chapter.label} · ${formatOffset(chapter.startMono - model.minMono, locale)}`}
            onClick={() => controller.seek(chapter.startMono)}
            data-testid="chapter"
          >
            {chapter.label}
          </button>
        ))}
      </div>
    </div>
  );
});

const ActionsRow = memo(function ActionsRow({ archive }: LaneProps) {
  const controller = useController();
  const i18n = useI18n();
  const locale = usePlayerState((state) => state.locale);
  const selectedEventId = usePlayerState((state) =>
    state.selection?.kind === "event" ? state.selection.id : null
  );
  const { view, model } = archive;

  return (
    <div className="tl-row">
      <span className="tl-label">{i18n.tn("actionsLane")}</span>
      <div className="tl-track" data-testid="lane-actions">
        {view.actionMarks.map((mark) => {
          const event = model.eventById.get(mark.eventId);
          const label = `${mark.triggerType ?? mark.actId} · ${formatOffset(mark.mono - model.minMono, locale)}`;

          return (
            <button
              key={mark.actId}
              type="button"
              className={`act act-${mark.kind}${selectedEventId === mark.eventId ? " cur" : ""}`}
              style={{ left: `${(mark.ratio * 100).toFixed(3)}%` }}
              aria-label={label}
              title={label}
              onClick={() => (event ? controller.selectEvent(event) : controller.seek(mark.mono))}
              data-testid="action-mark"
            />
          );
        })}
      </div>
    </div>
  );
});

const ScrubLanes = memo(function ScrubLanes({ archive }: LaneProps) {
  const i18n = useI18n();
  const locale = usePlayerState((state) => state.locale);
  const { view } = archive;
  const maxBin = Math.max(1, ...view.densityBins.map((bin) => bin.count));

  return (
    <>
      <div className="tl-row" aria-hidden="true">
        <span className="tl-label">{i18n.tn("errorsLane")}</span>
        <div className="tl-track" data-lane="errors" data-testid="lane-errors">
          {view.errorTicks.map((tick) => (
            <i key={tick} className="tick err" style={{ left: `${(tick * 100).toFixed(3)}%` }} />
          ))}
        </div>
      </div>
      <div className="tl-row" aria-hidden="true">
        <span className="tl-label">{i18n.tn("networkLane")}</span>
        <div className="tl-track tall" data-lane="network" data-testid="lane-network">
          {view.densityBins.map((bin, index) =>
            bin.count > 0 ? (
              <i
                key={index}
                className={bin.failed ? "bar hot" : "bar"}
                style={{
                  left: `${((index / view.densityBins.length) * 100).toFixed(3)}%`,
                  width: `calc(${(100 / view.densityBins.length).toFixed(3)}% - 1px)`,
                  height: `${Math.max(18, (bin.count / maxBin) * 100).toFixed(1)}%`
                }}
              />
            ) : null
          )}
        </div>
      </div>
      <div className="tl-row" aria-hidden="true">
        <span className="tl-label">{i18n.tn("realtimeLane")}</span>
        <div className="tl-track" data-lane="realtime" data-testid="lane-realtime">
          {view.realtimeTicks.map((tick) => (
            <i key={tick} className="tick ws" style={{ left: `${(tick * 100).toFixed(3)}%` }} />
          ))}
        </div>
      </div>
      <div className="tl-row" aria-hidden="true">
        <span />
        <div className="ruler">
          {rulerTicks(archive).map((tick) => (
            <span
              key={tick.ms}
              className={tick.last ? "ruler-tick last" : "ruler-tick"}
              style={{ left: `${(tick.ratio * 100).toFixed(3)}%` }}
            >
              {formatRulerSeconds(tick.ms, locale, tick.last ? 1 : 0)}
            </span>
          ))}
        </div>
      </div>
    </>
  );
});
