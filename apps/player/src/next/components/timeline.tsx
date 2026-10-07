import {
  memo,
  useMemo,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent
} from "react";

import { buildExpandedLanes, thinBySlot, type ExpandedLanes } from "../../core/expanded-lanes.js";
import {
  formatClock,
  formatOffset,
  formatRulerSeconds,
  resolveRulerStepMs
} from "../../core/format.js";
import { ratioOf } from "../../core/timeline-lanes.js";
import { formatPointerLaneLabel, POINTER_LANE_PRIORITY } from "../../lib/pointer-overlay.js";
import { useController, useI18n, usePlayerState } from "../context.js";
import { useScrubHover } from "../features/feed/index.js";
import type { LoadedArchive } from "../state.js";
import { Icon } from "./icon.js";
import { useLaneCapacity, useRovingLane } from "./lane-marks.js";

type Lane = "errors" | "network" | "realtime" | "navigation" | "console" | "storage" | "tabs";

/** Share of the track width within which a lane click picks the nearest item. */
const PICK_TOLERANCE = 0.015;

const lanesCache = new WeakMap<LoadedArchive, ExpandedLanes>();

/** The extra lanes of "Expand lanes", built once per archive. */
function expandedLanesOf(archive: LoadedArchive): ExpandedLanes {
  let lanes = lanesCache.get(archive);

  if (!lanes) {
    lanes = buildExpandedLanes(archive.model, archive.view.window);
    lanesCache.set(archive, lanes);
  }

  return lanes;
}

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

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(3)}%`;
}

export function Timeline() {
  const controller = useController();
  const i18n = useI18n();
  const archive = usePlayerState((state) => state.archive);
  const playheadMono = usePlayerState((state) => state.playheadMono);
  const locale = usePlayerState((state) => state.locale);
  const range = usePlayerState((state) => state.range);
  const expanded = usePlayerState((state) => state.lanesExpanded);
  const scrubbing = useRef(false);
  /** Shift+drag: the time the range selection started from. */
  const rangeAnchor = useRef<number | null>(null);
  const hover = useScrubHover(archive);

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
  const monoAt = (value: number): number => span.minMono + value * span.durationMono;
  const lanes = expanded ? expandedLanesOf(archive) : null;

  const pickNearest = (lane: Lane, value: number): boolean => {
    const mono = monoAt(value);
    const tolerance = span.durationMono * PICK_TOLERANCE;
    const selectById = (eventId: string) => () => {
      const event = model.eventById.get(eventId);

      if (event) {
        controller.selectEvent(event);
      }
    };
    const candidates: { mono: number; pick: () => void }[] =
      lane === "errors"
        ? view.errorEvents.map((event) => ({
            mono: event.mono,
            pick: () => controller.selectEvent(event)
          }))
        : lane === "realtime"
          ? model.realtime.map((entry) => ({ mono: entry.mono, pick: selectById(entry.eventId) }))
          : lane === "network"
            ? model.waterfall.map((entry) => ({
                mono: entry.startMono,
                pick: () => controller.select({ kind: "request", id: entry.reqId })
              }))
            : ((lane === "console" ? lanes?.console.marks : lanes?.[lane]) ?? []).map((entry) => ({
                mono: entry.mono,
                pick: selectById(entry.eventId)
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
      Lane | undefined;

    surface.focus();
    hover.onLeave();
    surface.setPointerCapture(event.pointerId);

    if (event.shiftKey) {
      // Shift+drag selects a range (PROPOSAL §4); the playhead stays where it is.
      rangeAnchor.current = monoAt(value);
      return;
    }

    if (lane && pickNearest(lane, value)) {
      surface.releasePointerCapture(event.pointerId);
      return;
    }

    scrubbing.current = true;
    controller.seek(monoAt(value));
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const value = trackRatio(event.currentTarget, event.clientX);

    if (rangeAnchor.current !== null) {
      controller.setRange({ startMono: rangeAnchor.current, endMono: monoAt(value) });
    } else if (scrubbing.current) {
      controller.seek(monoAt(value));
    } else if (event.pointerType !== "touch") {
      const top = event.currentTarget.getBoundingClientRect().top;
      hover.onMove(monoAt(value), event.clientX, top);
    }
  };

  const stopScrubbing = (event: PointerEvent<HTMLDivElement>): void => {
    scrubbing.current = false;
    rangeAnchor.current = null;

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
    <div className={expanded ? "tl tl-expanded" : "tl"} data-testid="timeline">
      <div className="tl-body" style={style}>
        <ChaptersRow archive={archive} />
        <ActionsRow archive={archive} />
        {lanes ? <PointerRow archive={archive} lanes={lanes} /> : null}
        {lanes ? <FilmstripRow archive={archive} lanes={lanes} /> : null}
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
          onPointerLeave={hover.onLeave}
          onKeyDown={handleKeyDown}
          data-testid="scrubber"
        >
          <ScrubLanes archive={archive} lanes={lanes} />
        </div>
        {range ? (
          <i
            className="tl-range"
            style={
              {
                "--rs": ratioOf(range.startMono, span).toFixed(4),
                "--re": ratioOf(range.endMono, span).toFixed(4)
              } as CSSProperties
            }
            aria-hidden="true"
            data-testid="timeline-range"
          />
        ) : null}
        <i
          className="playhead"
          data-t={formatClock(offset, locale)}
          aria-hidden="true"
          data-testid="playhead"
        />
      </div>
      <TimelineFooter archive={archive} />
      {hover.card}
    </div>
  );
}

type LaneProps = { archive: LoadedArchive };
type ExpandedLaneProps = LaneProps & { lanes: ExpandedLanes };

/** Key hints, the selected range (with "clear") and the "Expand lanes" switch. */
function TimelineFooter({ archive }: LaneProps) {
  const controller = useController();
  const i18n = useI18n();
  const locale = usePlayerState((state) => state.locale);
  const range = usePlayerState((state) => state.range);
  const expanded = usePlayerState((state) => state.lanesExpanded);
  const minMono = archive.model.minMono;

  return (
    <div className="tl-foot">
      {range ? (
        <span className="chip tl-range-chip" data-testid="range-chip">
          {i18n.tn("rangeChip", {
            range: `${formatClock(range.startMono - minMono, locale)} – ${formatClock(
              range.endMono - minMono,
              locale
            )}`
          })}
          <button
            type="button"
            className="btn small icon-only"
            aria-label={i18n.tn("clearRange")}
            title={i18n.tn("clearRange")}
            onClick={() => controller.clearRange()}
            data-testid="range-clear"
          >
            <Icon name="close" />
          </button>
        </span>
      ) : (
        <p className="hints">
          {i18n.tn("keyHints")} · {i18n.tn("rangeHint")}
        </p>
      )}
      <button
        type="button"
        className="btn small"
        aria-pressed={expanded}
        title={i18n.tn("expandLanesHint")}
        onClick={() => controller.setLanesExpanded(!expanded)}
        data-testid="expand-lanes"
      >
        <Icon name="lanes" />
        <span>{i18n.tn("expandLanes")}</span>
      </button>
    </div>
  );
}

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
              left: percent(ratioOf(chapter.startMono, span)),
              width: percent(ratioOf(chapter.endMono, span) - ratioOf(chapter.startMono, span))
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
      <div className="tl-track marks" data-testid="lane-actions">
        {view.actionMarks.map((mark) => {
          const event = model.eventById.get(mark.eventId);
          const label = `${mark.triggerType ?? mark.actId} · ${formatOffset(mark.mono - model.minMono, locale)}`;

          return (
            <button
              key={mark.actId}
              type="button"
              className={`act act-${mark.kind}${selectedEventId === mark.eventId ? " cur" : ""}`}
              style={{ left: percent(mark.ratio) }}
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

/** Clicks, other buttons, gestures, and rage / dead clicks (the classic pointer lane). */
const PointerRow = memo(function PointerRow({ archive, lanes }: ExpandedLaneProps) {
  const controller = useController();
  const i18n = useI18n();
  const locale = usePlayerState((state) => state.locale);
  const { model } = archive;
  const [capacity, trackRef] = useLaneCapacity();
  // One mark per 24 px of track, the most telling one (rage / dead clicks first).
  const marks = useMemo(
    () => thinBySlot(lanes.pointer, capacity, (mark) => POINTER_LANE_PRIORITY[mark.kind]),
    [lanes.pointer, capacity]
  );
  const roving = useRovingLane(marks.length);
  const laneLabel = i18n.tn("pointerLane");

  return (
    <div className="tl-row">
      <span className="tl-label">{laneLabel}</span>
      <div
        ref={trackRef}
        className="tl-track marks"
        role="toolbar"
        aria-label={laneLabel}
        onKeyDown={roving.onKeyDown}
        data-testid="lane-pointer"
      >
        {marks.map((mark, index) => {
          // Labelled in the current locale, not the one the archive was opened in.
          const label = i18n.tn("pointerMark", {
            label: formatPointerLaneLabel(i18n.formatPointerKind(mark.kind), mark.target),
            time: formatOffset(mark.mono - model.minMono, locale)
          });
          const event = mark.eventId ? model.eventById.get(mark.eventId) : undefined;

          return (
            <button
              key={`${mark.mono}-${mark.kind}`}
              type="button"
              className={`pmark pmark-${mark.tone}`}
              style={{ left: percent(mark.ratio) }}
              tabIndex={roving.tabIndexOf(index)}
              aria-label={label}
              title={label}
              onFocus={() => roving.focusIndex(index)}
              onClick={() => (event ? controller.selectEvent(event) : controller.seek(mark.mono))}
              data-testid="pointer-mark"
              data-kind={mark.kind}
            />
          );
        })}
      </div>
    </div>
  );
});

/** One button per screenshot (the classic filmstrip), thinned to the track's width. */
const FilmstripRow = memo(function FilmstripRow({ archive, lanes }: ExpandedLaneProps) {
  const controller = useController();
  const i18n = useI18n();
  const locale = usePlayerState((state) => state.locale);
  const { model } = archive;
  const [capacity, trackRef] = useLaneCapacity();
  const frames = useMemo(() => thinBySlot(lanes.filmstrip, capacity), [lanes.filmstrip, capacity]);
  const roving = useRovingLane(frames.length);
  const laneLabel = i18n.tn("filmstripLane");

  if (frames.length === 0) {
    return null;
  }

  return (
    <div className="tl-row">
      <span className="tl-label">{laneLabel}</span>
      <div
        ref={trackRef}
        className="tl-track marks"
        role="toolbar"
        aria-label={laneLabel}
        onKeyDown={roving.onKeyDown}
        data-testid="lane-filmstrip"
      >
        {frames.map((frame, index) => {
          const label = i18n.tn("filmstripFrame", {
            time: formatOffset(frame.mono - model.minMono, locale)
          });
          const event = model.eventById.get(frame.eventId);

          return (
            <button
              key={frame.eventId}
              type="button"
              className="film"
              style={{ left: percent(frame.ratio) }}
              tabIndex={roving.tabIndexOf(index)}
              aria-label={label}
              title={label}
              onFocus={() => roving.focusIndex(index)}
              onClick={() => (event ? controller.selectEvent(event) : controller.seek(frame.mono))}
              data-testid="filmstrip-frame"
            />
          );
        })}
      </div>
    </div>
  );
});

type TickRowProps = {
  label: string;
  lane?: Lane;
  testId: string;
  ticks: readonly number[];
  tone: string;
  /** A second set drawn in another tone over the first (console errors over log lines). */
  alertTicks?: readonly number[];
};

function TickRow({ label, lane, testId, ticks, tone, alertTicks = [] }: TickRowProps) {
  return (
    <div className="tl-row" aria-hidden="true">
      <span className="tl-label">{label}</span>
      <div className="tl-track" data-lane={lane} data-testid={testId}>
        {ticks.map((tick) => (
          <i key={tick} className={`tick ${tone}`} style={{ left: percent(tick) }} />
        ))}
        {alertTicks.map((tick) => (
          <i key={`alert-${tick}`} className="tick err" style={{ left: percent(tick) }} />
        ))}
      </div>
    </div>
  );
}

/** Tick positions of marks, de-duplicated to the drawn precision. */
function ticksOf(marks: readonly { ratio: number }[]): number[] {
  return [...new Set(marks.map((mark) => Number(mark.ratio.toFixed(3))))];
}

type ScrubLanesProps = LaneProps & { lanes: ExpandedLanes | null };

const ScrubLanes = memo(function ScrubLanes({ archive, lanes }: ScrubLanesProps) {
  const i18n = useI18n();
  const locale = usePlayerState((state) => state.locale);
  const { view } = archive;
  const maxBin = Math.max(1, ...view.densityBins.map((bin) => bin.count));
  const extra = useMemo(
    () =>
      lanes
        ? {
            navigation: ticksOf(lanes.navigation),
            storage: ticksOf(lanes.storage),
            tabs: ticksOf(lanes.tabs)
          }
        : null,
    [lanes]
  );

  return (
    <>
      {extra ? (
        <TickRow
          label={i18n.tn("navigationLane")}
          lane="navigation"
          testId="lane-navigation"
          ticks={extra.navigation}
          tone="nav"
        />
      ) : null}
      <TickRow
        label={i18n.tn("errorsLane")}
        lane="errors"
        testId="lane-errors"
        ticks={view.errorTicks}
        tone="err"
      />
      <div className="tl-row" aria-hidden="true">
        <span className="tl-label">{i18n.tn("networkLane")}</span>
        <div className="tl-track tall" data-lane="network" data-testid="lane-network">
          {view.densityBins.map((bin, index) =>
            bin.count > 0 ? (
              <i
                key={index}
                className={bin.failed ? "bar hot" : "bar"}
                style={{
                  left: percent(index / view.densityBins.length),
                  width: `calc(${(100 / view.densityBins.length).toFixed(3)}% - 1px)`,
                  height: `${Math.max(18, (bin.count / maxBin) * 100).toFixed(1)}%`
                }}
              />
            ) : null
          )}
        </div>
      </div>
      <TickRow
        label={i18n.tn("realtimeLane")}
        lane="realtime"
        testId="lane-realtime"
        ticks={view.realtimeTicks}
        tone="ws"
      />
      {lanes && extra ? (
        <>
          <TickRow
            label={i18n.tn("consoleLane")}
            lane="console"
            testId="lane-console"
            ticks={lanes.console.ticks}
            tone="log"
            alertTicks={lanes.console.errorTicks}
          />
          <TickRow
            label={i18n.tn("storageLane")}
            lane="storage"
            testId="lane-storage"
            ticks={extra.storage}
            tone="store"
          />
          {lanes.recordings.length > 0 ? (
            <div className="tl-row" aria-hidden="true">
              <span className="tl-label">{i18n.tn("recordingLane")}</span>
              <div className="tl-track" data-testid="lane-recording">
                {lanes.recordings.map((recording) => (
                  <i
                    key={recording.recordingId}
                    className="rec-span"
                    style={{
                      left: percent(recording.startRatio),
                      width: percent(Math.max(0.002, recording.endRatio - recording.startRatio))
                    }}
                  />
                ))}
              </div>
            </div>
          ) : null}
          {extra.tabs.length > 0 ? (
            <TickRow
              label={i18n.tn("tabsLane")}
              lane="tabs"
              testId="lane-tabs"
              ticks={extra.tabs}
              tone="tabs"
            />
          ) : null}
        </>
      ) : null}
      <div className="tl-row" aria-hidden="true">
        <span />
        <div className="ruler">
          {rulerTicks(archive).map((tick) => (
            <span
              key={tick.ms}
              className={tick.last ? "ruler-tick last" : "ruler-tick"}
              style={{ left: percent(tick.ratio) }}
            >
              {formatRulerSeconds(tick.ms, locale, tick.last ? 1 : 0)}
            </span>
          ))}
        </div>
      </div>
    </>
  );
});
