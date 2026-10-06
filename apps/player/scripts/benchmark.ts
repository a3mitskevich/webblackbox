/**
 * Player bench on a long recording (PROPOSAL §12: "follow + rail re-render every 120 ms on long
 * recordings"). Builds a ~10-minute synthetic archive (`synthetic-long-session.mjs`), opens it with
 * player-sdk, builds the Player's archive model and session view, the per-archive rail derivations,
 * then replays the session in 120 ms ticks and times what the UI recomputes on every tick while
 * playing with "Follow playhead" on. `BENCH_OUTPUT=json` (or `--json`) prints one JSON line for
 * `scripts/bench-regression-check.mjs`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  buildPerformanceSeries,
  getRelatedTabsAt,
  readWebVitals,
  WebBlackboxPlayer
} from "@webblackbox/player-sdk";

import { buildArchiveModel } from "../src/core/archive-model.js";
import { buildSessionView } from "../src/core/session-view.js";
import {
  buildScreenshotTrail,
  resolveScreenRecordingForMono,
  resolveScreenshotMarker,
  resolveShotForMono
} from "../src/core/stage-media.js";
import { ratioOf } from "../src/core/timeline-lanes.js";
import { createPlayerI18n } from "../src/lib/i18n.js";
import { buildRippleMarks } from "../src/lib/pointer-overlay.js";
import { upperBoundByMono } from "../src/lib/range.js";
import { buildConsoleView } from "../src/next/features/console/console-model.js";
import { consoleSlice } from "../src/next/features/console/slice.js";
import { countActivity, feedViewOf } from "../src/next/features/feed/feed-view.js";
import { labelStreamMessages, shownStream } from "../src/next/features/network/message-labels.js";
import {
  buildNetworkView,
  followIndex,
  getNetworkModel
} from "../src/next/features/network/rows.js";
import { networkSlice } from "../src/next/features/network/slice.js";
import {
  selectStorageData,
  selectStorageStateAt
} from "../src/next/features/storage/storage-model.js";
import type { LoadedArchive } from "../src/next/state.js";
import {
  buildLongSyntheticSession,
  createLongPlainArchive,
  LONG_SESSION_DEFAULTS
} from "./lib/synthetic-long-session.mjs";

/** The lists' "now" bucket while playing (`NOW_BUCKET_MS` in the feed, network and console). */
const TICK_MS = 120;
/** The storage state view's bucket (`STATE_BUCKET_MS` in storage-panel.tsx). */
const STORAGE_BUCKET_MS = 250;

type TickPanel =
  "stage" | "feed" | "network" | "console" | "realtime" | "storage" | "tabs" | "perf";

type Percentiles = { p50: number; p95: number; max: number };

/** The jsdom render pass (`bench/render-ticks.bench.tsx`): React work per playhead tick. */
export type PlayerRenderReport = {
  openRenderMs: number;
  ticks: number;
  tickP50: number;
  tickP95: number;
  failedPanels: string[];
  tabs: Record<string, { firstRenderMs: number; tickP50: number; tickP95: number }>;
};

export type PlayerBenchmarkReport = {
  eventCount: number;
  durationMs: number;
  archiveBytes: number;
  generateMs: number;
  openMs: number;
  modelBuildMs: number;
  derivationsMs: number;
  derivations: Record<string, number>;
  tickCount: number;
  tickMs: Percentiles;
  tickPanelsP95: Record<TickPanel, number>;
  /** `null` when skipped (`BENCH_PLAYER_RENDER=0`). */
  render: PlayerRenderReport | null;
};

const playerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function time<T>(run: () => T): [T, number] {
  const start = performance.now();
  const value = run();
  return [value, performance.now() - start];
}

async function timeAsync<T>(run: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const value = await run();
  return [value, performance.now() - start];
}

function percentiles(samples: readonly number[]): Percentiles {
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (ratio: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(ratio * sorted.length))] ?? 0;
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] ?? 0 };
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

/**
 * Runs the jsdom render pass in vitest (it needs a DOM, CSS imports and the React test renderer)
 * and reads the report it writes. Its console output is shown only when it fails.
 */
function runRenderPass(): PlayerRenderReport | null {
  if (process.env.BENCH_PLAYER_RENDER === "0") {
    return null;
  }

  const dir = mkdtempSync(join(tmpdir(), "wb-player-bench-"));
  const reportPath = join(dir, "render.json");

  try {
    const result = spawnSync(
      "pnpm",
      ["exec", "vitest", "run", "--config", "scripts/bench/vitest.config.ts"],
      {
        cwd: playerRoot,
        encoding: "utf8",
        env: { ...process.env, BENCH_RENDER_REPORT: reportPath }
      }
    );

    if (result.status !== 0) {
      throw new Error(
        `Player render pass failed:\n${(result.stdout ?? "").slice(-4_000)}\n${(result.stderr ?? "").slice(-4_000)}`
      );
    }

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as PlayerRenderReport;
    const roundTabs = Object.fromEntries(
      Object.entries(report.tabs).map(([tab, value]) => [
        tab,
        {
          firstRenderMs: round(value.firstRenderMs),
          tickP50: round(value.tickP50),
          tickP95: round(value.tickP95)
        }
      ])
    );

    return {
      ...report,
      openRenderMs: round(report.openRenderMs),
      tickP50: round(report.tickP50),
      tickP95: round(report.tickP95),
      tabs: roundTabs
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function run(): Promise<PlayerBenchmarkReport> {
  const events = readPositiveInt("BENCH_PLAYER_EVENTS", LONG_SESSION_DEFAULTS.events);
  const durationMs = readPositiveInt("BENCH_PLAYER_DURATION_MS", LONG_SESSION_DEFAULTS.durationMs);

  const [bytes, generateMs] = await timeAsync(() =>
    createLongPlainArchive(buildLongSyntheticSession({ events, durationMs }))
  );
  const [player, openMs] = await timeAsync(() => WebBlackboxPlayer.open(bytes));

  // As the controller does when an archive finishes loading.
  const i18n = createPlayerI18n("en");
  const [archive, modelBuildMs] = time((): LoadedArchive => {
    const model = buildArchiveModel(player, {
      pointerReasonClick: i18n.messages.pointerReasonActionClick,
      pointerReasonMove: i18n.messages.pointerReasonMove,
      formatPointerKind: i18n.formatPointerKind
    });
    return {
      fileName: "long.webblackbox",
      player,
      model,
      view: buildSessionView(player.archive, model),
      bytes
    };
  });
  const { model, view } = archive;

  // A selected row in the middle of the session: the lists look it up on every render.
  const selectedEvent = model.events[Math.floor(model.events.length / 2)];
  const selectedEventId = selectedEvent?.id ?? null;

  const derivations: Record<string, number> = {};
  const derive = <T>(name: string, compute: () => T): T => {
    const [value, ms] = time(compute);
    derivations[name] = round(ms);
    return value;
  };

  const feed = derive("feed", () =>
    feedViewOf(archive, {
      query: "",
      errorsOnly: false,
      hideThirdParty: true,
      scope: "all",
      expanded: [],
      selectedEventId,
      locale: "en"
    })
  );
  derive("activityCount", () => countActivity(archive, "", "en"));
  const networkModel = derive("networkModel", () => getNetworkModel(archive));
  const networkView = derive("networkRows", () => {
    const slice = networkSlice.initial;
    return buildNetworkView(
      networkModel,
      {
        query: "",
        type: slice.type,
        failedOnly: slice.failedOnly,
        notCapturedOnly: slice.notCapturedOnly,
        hideThirdParty: slice.hideThirdParty
      },
      slice.sort,
      "en"
    );
  });
  const consoleView = derive("console", () => buildConsoleView(archive, consoleSlice.initial, ""));
  const consoleIndex = derive(
    "consoleIndex",
    () =>
      new Map(
        consoleView.rows.flatMap((row, index) =>
          row.memberIds.map((id): [string, number] => [id, index])
        )
      )
  );
  const labels = derive("realtime", () => {
    const stream = shownStream(networkModel, null, null);
    return stream ? labelStreamMessages(stream, true) : [];
  });
  derive("storage", () => selectStorageData(archive));
  const perfEvents = derive("perf", () => {
    const perf = model.events.filter((event) => event.type.startsWith("perf."));
    buildPerformanceSeries({
      events: perf,
      requests: model.waterfall,
      minMono: model.minMono,
      maxMono: model.maxMono
    });
    return perf;
  });
  const derivationsMs = Object.values(derivations).reduce((sum, ms) => sum + ms, 0);

  const panelSamples: Record<TickPanel, number[]> = {
    stage: [],
    feed: [],
    network: [],
    console: [],
    realtime: [],
    storage: [],
    tabs: [],
    perf: []
  };
  const tickSamples: number[] = [];
  const selectedRow = networkView.rows[Math.floor(networkView.rows.length / 2)] ?? null;
  const selectedLabelId = labels[Math.floor(labels.length / 2)]?.entry.eventId ?? null;
  const chaptersNewestFirst = [...view.chapters].reverse();
  let storageBucket = Number.NaN;
  let checksum = 0;

  for (let now = model.minMono; now <= model.maxMono; now += TICK_MS) {
    const tickStart = performance.now();
    const sample = (panel: TickPanel, compute: () => number): void => {
      const start = performance.now();
      checksum += compute();
      panelSamples[panel].push(performance.now() - start);
    };

    // Stage, transport and timeline (stage.tsx, timeline.tsx): media, pointer, route, playhead.
    sample("stage", () => {
      const recording = resolveScreenRecordingForMono(model.screenRecordings, now);
      const shot = recording ? null : resolveShotForMono(model.screenshots, now);
      const trail = buildScreenshotTrail(model.pointers, now);
      const marker = resolveScreenshotMarker(model.pointers, now, shot?.marker ?? null);
      const ripples = buildRippleMarks(model.pointerActions, now);
      // stage.tsx `currentRoute` (module-private there): the latest chapter at the playhead.
      const route = chaptersNewestFirst.find((chapter) => chapter.startMono <= now);
      return (
        trail.length +
        ripples.length +
        (marker ? 1 : 0) +
        (route ? 1 : 0) +
        ratioOf(now, view.window)
      );
    });
    // Activity feed (activity-feed.tsx): the "now" line and the selected row.
    sample("feed", () => {
      const nowIndex = upperBoundByMono(feed.entries, now, (entry) => entry.item.mono);
      const selected = feed.entries.findIndex((entry) => entry.item.eventId === selectedEventId);
      return nowIndex + selected;
    });
    // Network table (network-table.tsx): the follow target and the selected row.
    sample(
      "network",
      () =>
        followIndex(networkView.rows, now) +
        (selectedRow ? networkView.rows.indexOf(selectedRow) : -1)
    );
    // Console list (console-panel.tsx).
    sample("console", () => {
      const nowIndex = upperBoundByMono(consoleView.rows, now, (row) => row.entry.mono);
      return nowIndex + (consoleIndex.get(selectedEventId ?? "") ?? -1);
    });
    // Realtime conversation (realtime-panel.tsx): last message at or before the playhead.
    sample("realtime", () => {
      const lastPast = upperBoundByMono(labels, now, (label) => label.entry.mono) - 1;
      return lastPast + labels.findIndex((label) => label.entry.eventId === selectedLabelId);
    });
    // Storage state at the playhead (storage-panel.tsx), memoized per 250 ms bucket.
    sample("storage", () => {
      const bucket = Math.floor(now / STORAGE_BUCKET_MS);

      if (bucket === storageBucket) {
        return 0;
      }

      storageBucket = bucket;
      return Object.keys(selectStorageStateAt(archive, bucket * STORAGE_BUCKET_MS)).length;
    });
    // Tabs open at the playhead (tabs-panel.tsx) and web vitals at the playhead (perf-panel.tsx).
    sample("tabs", () => getRelatedTabsAt(model.tabsContext, now).length);
    sample("perf", () => Object.keys(readWebVitals(perfEvents, now)).length);

    tickSamples.push(performance.now() - tickStart);
  }

  if (!Number.isFinite(checksum)) {
    throw new Error("Bench checksum is not finite.");
  }

  const tickPanelsP95 = Object.fromEntries(
    Object.entries(panelSamples).map(([panel, samples]) => [panel, round(percentiles(samples).p95)])
  ) as Record<TickPanel, number>;
  const tick = percentiles(tickSamples);

  return {
    eventCount: model.events.length,
    durationMs: round(model.durationMono),
    archiveBytes: bytes.byteLength,
    generateMs: round(generateMs),
    openMs: round(openMs),
    modelBuildMs: round(modelBuildMs),
    derivationsMs: round(derivationsMs),
    derivations,
    tickCount: tickSamples.length,
    tickMs: { p50: round(tick.p50), p95: round(tick.p95), max: round(tick.max) },
    tickPanelsP95,
    render: runRenderPass()
  };
}

function shouldPrintJson(): boolean {
  return process.argv.includes("--json") || process.env.BENCH_OUTPUT === "json";
}

async function main(): Promise<void> {
  const report = await run();

  if (shouldPrintJson()) {
    console.log(JSON.stringify(report));
    return;
  }

  console.log("WebBlackbox Player Benchmarks (long recording)");
  console.log("----------------------------------------------");
  console.log(
    `Events: ${report.eventCount.toLocaleString()} over ${(report.durationMs / 1_000).toFixed(0)} s`
  );
  console.log(
    `Archive: ${(report.archiveBytes / 1_048_576).toFixed(2)} MB (built in ${report.generateMs.toFixed(0)} ms)`
  );
  console.log(`Open (player-sdk): ${report.openMs.toFixed(1)} ms`);
  console.log(`Archive model + session view: ${report.modelBuildMs.toFixed(1)} ms`);
  console.log(`Rail derivations: ${report.derivationsMs.toFixed(1)} ms`);

  for (const [name, ms] of Object.entries(report.derivations)) {
    console.log(`  ${name}: ${ms.toFixed(2)} ms`);
  }

  console.log(
    `Playhead ticks (${report.tickCount.toLocaleString()} × ${TICK_MS} ms): p50 ${report.tickMs.p50.toFixed(3)} ms, p95 ${report.tickMs.p95.toFixed(3)} ms, max ${report.tickMs.max.toFixed(3)} ms`
  );

  for (const [panel, ms] of Object.entries(report.tickPanelsP95)) {
    console.log(`  ${panel} p95: ${ms.toFixed(3)} ms`);
  }

  if (!report.render) {
    console.log("React render pass: skipped (BENCH_PLAYER_RENDER=0)");
    return;
  }

  console.log(
    `React render pass (jsdom, development build): open + first render ${report.render.openRenderMs.toFixed(0)} ms; per tick p50 ${report.render.tickP50.toFixed(2)} ms, p95 ${report.render.tickP95.toFixed(2)} ms over ${report.render.ticks} ticks`
  );

  for (const [tab, value] of Object.entries(report.render.tabs)) {
    console.log(
      `  ${tab}: p95 ${value.tickP95.toFixed(2)} ms (first render ${value.firstRenderMs.toFixed(1)} ms)`
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
