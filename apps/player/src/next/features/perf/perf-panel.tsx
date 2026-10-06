import "./perf.css";

import {
  buildPerformanceSeries,
  readLongTasks,
  readWebVitals,
  type PerformanceArtifactEntry,
  type WebVitals
} from "@webblackbox/player-sdk";
import { Download } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { formatOffset } from "../../../core/format.js";
import { useController, useI18n, usePlayerState } from "../../context.js";
import type { LoadedArchive } from "../../state.js";
import { useFeatureI18n } from "../messages.js";
import { perfMessages, type PerfTranslate } from "./messages.js";
import { PerfChart, type PerfChartSeries } from "./perf-chart.js";

const NOW_BUCKET_MS = 100;
const CHART_HEIGHT = 150;
const MS_PER_SECOND = 1_000;
const ICON_PROPS = { size: 14, strokeWidth: 1.5, absoluteStrokeWidth: true, "aria-hidden": true };

/** Core Web Vitals thresholds: good up to the first value, poor from the second. */
const VITAL_THRESHOLDS: Record<keyof WebVitals, readonly [number, number]> = {
  lcp: [2_500, 4_000],
  cls: [0.1, 0.25],
  inp: [200, 500],
  fid: [100, 300],
  ttfb: [800, 1_800]
};
const VITAL_ORDER: readonly (keyof WebVitals)[] = ["lcp", "cls", "inp", "ttfb"];

export function rateVital(name: keyof WebVitals, value: number): "good" | "needs" | "poor" {
  const [good, poor] = VITAL_THRESHOLDS[name];
  return value <= good ? "good" : value < poor ? "needs" : "poor";
}

function VitalTiles({ vitals, t }: { vitals: WebVitals; t: PerfTranslate }) {
  const i18n = useI18n();

  return (
    <div className="pf-vitals" data-testid="perf-vitals">
      {VITAL_ORDER.map((name) => {
        const value = vitals[name];
        const rating = value === undefined ? null : rateVital(name, value);

        return (
          <div
            key={name}
            className={rating ? `pf-vital ${rating}` : "pf-vital"}
            data-testid={`perf-vital-${name}`}
            data-rating={rating ?? "none"}
          >
            <span className="name">{name.toUpperCase()}</span>
            <b>
              {value === undefined
                ? "—"
                : name === "cls"
                  ? i18n.formatNumber(value, { fractionDigits: 3 })
                  : i18n.formatMilliseconds(value, { fractionDigits: 0 })}
            </b>
            <span className="hint">{rating ? t(`rating_${rating}`) : t("notRecorded")}</span>
          </div>
        );
      })}
    </div>
  );
}

type DownloadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "missing" };

function ArtifactRow({
  archive,
  entry,
  t
}: {
  archive: LoadedArchive;
  entry: PerformanceArtifactEntry;
  t: PerfTranslate;
}) {
  const i18n = useI18n();
  const controller = useController();
  const locale = usePlayerState((state) => state.locale);
  const [download, setDownload] = useState<DownloadState>({ status: "idle" });

  useEffect(
    () => () => {
      if (download.status === "ready") {
        URL.revokeObjectURL(download.url);
      }
    },
    [download]
  );

  const prepare = async (): Promise<void> => {
    if (!entry.hash) {
      return;
    }

    setDownload({ status: "loading" });
    const blob = await archive.player.getBlob(entry.hash).catch(() => null);
    setDownload(
      blob
        ? {
            status: "ready",
            url: URL.createObjectURL(
              new Blob([blob.bytes.slice()], { type: blob.mime || "application/json" })
            )
          }
        : { status: "missing" }
    );
  };

  return (
    <li className="pf-artifact" data-testid="perf-artifact">
      <button
        type="button"
        className="linklike mono"
        onClick={() => {
          const event = archive.model.eventById.get(entry.eventId);

          if (event) {
            controller.selectEvent(event);
          }
        }}
      >
        {formatOffset(entry.mono - archive.model.minMono, locale)}
      </button>
      <span className="kind">{t(`kind_${entry.kind}`)}</span>
      <span className="muted">{entry.reason ?? ""}</span>
      <span className="mono size">
        {entry.size !== undefined ? i18n.formatByteSize(entry.size) : ""}
      </span>
      {download.status === "ready" ? (
        <a
          className="btn small"
          href={download.url}
          download={`${entry.kind}-${entry.eventId}.json`}
          data-testid="perf-artifact-save"
        >
          <Download {...ICON_PROPS} />
          {t("save")}
        </a>
      ) : entry.hash ? (
        <button
          type="button"
          className="btn small"
          disabled={download.status === "loading" || download.status === "missing"}
          onClick={() => void prepare()}
          data-testid="perf-artifact-prepare"
        >
          {download.status === "missing" ? t("notInArchive") : t("prepare")}
        </button>
      ) : null}
    </li>
  );
}

const ARTIFACT_KINDS = new Set(["trace", "cpu", "heap", "other"]);

/**
 * Perf (R4): web vitals at the playhead, canvas series over the whole session (requests in
 * flight, transfer, failures, long tasks; uPlot) with the playhead, and the recorded artifacts.
 */
export function PerfPanel() {
  const controller = useController();
  const t = useFeatureI18n(perfMessages);
  const i18n = useI18n();
  const archive = usePlayerState((state) => state.archive);
  const theme = usePlayerState((state) => `${state.theme}-${state.locale}`);
  const locale = usePlayerState((state) => state.locale);
  const nowMono = usePlayerState((state) =>
    state.isPlaying
      ? Math.floor(state.playheadMono / NOW_BUCKET_MS) * NOW_BUCKET_MS
      : state.playheadMono
  );
  const perfEvents = useMemo(
    () => (archive ? archive.model.events.filter((event) => event.type.startsWith("perf.")) : []),
    [archive]
  );
  const series = useMemo(
    () =>
      archive
        ? buildPerformanceSeries({
            events: perfEvents,
            requests: archive.model.waterfall,
            minMono: archive.model.minMono,
            maxMono: archive.model.maxMono
          })
        : null,
    [archive, perfEvents]
  );
  const offsets = useMemo(
    () => series?.offsets.map((offset) => offset / MS_PER_SECOND) ?? [],
    [series]
  );
  const networkSeries = useMemo<PerfChartSeries[]>(
    () =>
      series
        ? [
            { label: t("inFlight"), colorToken: "--accent", values: series.requestsInFlight },
            { label: t("failed"), colorToken: "--bad", values: series.failedRequests, bars: true },
            { label: t("transfer"), colorToken: "--ws", values: series.transferKib, scale: "y2" }
          ]
        : [],
    [series, t]
  );
  const mainSeries = useMemo<PerfChartSeries[]>(
    () =>
      series
        ? [{ label: t("longTasks"), colorToken: "--warn", values: series.longTaskMs, bars: true }]
        : [],
    [series, t]
  );
  const vitals = useMemo(() => readWebVitals(perfEvents, nowMono), [perfEvents, nowMono]);
  const longTasks = useMemo(() => readLongTasks(perfEvents), [perfEvents]);
  const artifacts = archive
    ? archive.model.perf.filter((entry) => ARTIFACT_KINDS.has(entry.kind))
    : [];

  if (!archive || !series) {
    return null;
  }

  const playhead = (nowMono - archive.model.minMono) / MS_PER_SECOND;
  const seek = (seconds: number): void =>
    controller.seek(archive.model.minMono + seconds * MS_PER_SECOND);
  const totalLongTaskMs = longTasks.reduce((sum, task) => sum + task.durationMs, 0);

  return (
    <div className="pf" data-testid="perf-panel">
      <section aria-labelledby="pf-vitals-head">
        <h3 id="pf-vitals-head" className="pf-head">
          {t("vitalsAt", { time: formatOffset(nowMono - archive.model.minMono, locale) })}
        </h3>
        <VitalTiles vitals={vitals} t={t} />
      </section>
      <section aria-labelledby="pf-network-head">
        <h3 id="pf-network-head" className="pf-head">
          {t("networkHeading")}
        </h3>
        <PerfChart
          offsets={offsets}
          series={networkSeries}
          height={CHART_HEIGHT}
          playhead={playhead}
          onSeek={seek}
          label={t("networkHeading")}
          timeLabel={t("time")}
          themeKey={theme}
          testId="perf-chart-network"
        />
      </section>
      <section aria-labelledby="pf-main-head">
        <h3 id="pf-main-head" className="pf-head">
          {t("mainHeading")}{" "}
          <span className="muted" data-testid="perf-long-tasks">
            {longTasks.length > 0
              ? t("longTaskSummary", {
                  count: i18n.formatNumber(longTasks.length),
                  total: i18n.formatMilliseconds(totalLongTaskMs, { fractionDigits: 0 })
                })
              : t("noLongTasks")}
          </span>
        </h3>
        <PerfChart
          offsets={offsets}
          series={mainSeries}
          height={110}
          playhead={playhead}
          onSeek={seek}
          label={t("mainHeading")}
          timeLabel={t("time")}
          themeKey={theme}
          testId="perf-chart-main"
        />
      </section>
      <section aria-labelledby="pf-artifacts-head">
        <h3 id="pf-artifacts-head" className="pf-head">
          {t("artifacts")}
        </h3>
        {artifacts.length === 0 ? (
          <p className="pf-none">{t("noArtifacts")}</p>
        ) : (
          <ul className="pf-artifacts" data-testid="perf-artifacts">
            {artifacts.map((entry) => (
              <ArtifactRow key={entry.eventId} archive={archive} entry={entry} t={t} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default PerfPanel;
