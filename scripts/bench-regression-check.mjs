#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const thresholdsPath = resolve(root, "benchmarks/ci-thresholds.json");
const reportPath = resolve(root, "benchmarks/last-ci-report.json");

const ciEnv = {
  BENCH_OUTPUT: "json",
  BENCH_RING_EVENTS: process.env.BENCH_RING_EVENTS ?? "60000",
  BENCH_RECORDER_EVENTS: process.env.BENCH_RECORDER_EVENTS ?? "80000",
  BENCH_PIPELINE_EVENTS: process.env.BENCH_PIPELINE_EVENTS ?? "12000",
  BENCH_PAYLOAD_BYTES: process.env.BENCH_PAYLOAD_BYTES ?? "900",
  BENCH_SCREENSHOT_INTERVAL: process.env.BENCH_SCREENSHOT_INTERVAL ?? "120",
  BENCH_BLOB_POOL: process.env.BENCH_BLOB_POOL ?? "24",
  BENCH_BLOB_BYTES: process.env.BENCH_BLOB_BYTES ?? "24576",
  BENCH_MAX_ARCHIVE_MB: process.env.BENCH_MAX_ARCHIVE_MB ?? "100",
  BENCH_RECENT_MINUTES: process.env.BENCH_RECENT_MINUTES ?? "20",
  BENCH_VOLUME_EVENTS: process.env.BENCH_VOLUME_EVENTS ?? "100000",
  BENCH_VOLUME_BLOBS: process.env.BENCH_VOLUME_BLOBS ?? "2000",
  BENCH_VOLUME_BLOB_MIN_KB: process.env.BENCH_VOLUME_BLOB_MIN_KB ?? "100",
  BENCH_VOLUME_BLOB_MAX_KB: process.env.BENCH_VOLUME_BLOB_MAX_KB ?? "500",
  BENCH_PLAYER_EVENTS: process.env.BENCH_PLAYER_EVENTS ?? "60000",
  BENCH_PLAYER_DURATION_MS: process.env.BENCH_PLAYER_DURATION_MS ?? "600000",
  BENCH_PLAYER_RENDER_TICKS: process.env.BENCH_PLAYER_RENDER_TICKS ?? "120",
  // The render pass is part of the gate: an inherited BENCH_PLAYER_RENDER=0 must not skip it.
  BENCH_PLAYER_RENDER: "1"
};
// The default export policy's size cap (protocol DEFAULT_EXPORT_POLICY.maxArchiveBytes).
const DEFAULT_EXPORT_MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const thresholds = JSON.parse(await readFile(thresholdsPath, "utf8"));
  const recorder = runBenchCommand(["--filter", "@webblackbox/recorder", "bench"]);
  const pipeline = runBenchCommand(["--filter", "@webblackbox/pipeline", "bench"]);
  const pipelineVolumes = runBenchCommand(["--filter", "@webblackbox/pipeline", "bench:volumes"]);
  const player = runBenchCommand(["--filter", "@webblackbox/player", "bench"]);
  const checks = [
    ...runChecks(recorder, pipeline, thresholds),
    ...runVolumeChecks(pipelineVolumes, thresholds.pipelineVolumes),
    ...runPlayerChecks(player, thresholds.player)
  ];

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        env: ciEnv,
        recorder,
        pipeline,
        pipelineVolumes,
        player,
        checks
      },
      null,
      2
    ),
    "utf8"
  );

  const failed = checks.filter((check) => !check.ok);

  console.log(
    "Recorder ingest throughput:",
    Math.round(recorder.recorderIngest.throughputOpsPerSec)
  );
  console.log("Pipeline ingest throughput:", Math.round(pipeline.ingestThroughputOpsPerSec));
  console.log(
    "Pipeline volume export (default policy):",
    `${Math.round(pipelineVolumes.defaultExport.durationMs)} ms,`,
    `peak RSS +${Math.round(pipelineVolumes.defaultExport.peakRssDeltaMb)} MB`
  );
  console.log(
    "Player long archive:",
    `${player.eventCount} events, open ${Math.round(player.openMs)} ms,`,
    `model ${Math.round(player.modelBuildMs)} ms, tick p95 ${player.tickMs.p95.toFixed(3)} ms,`,
    `render tick p95 ${player.render ? player.render.tickP95.toFixed(2) : "skipped"} ms`
  );
  console.log("Benchmark report:", reportPath);

  if (failed.length > 0) {
    const detail = failed.map((check) => `- ${check.name}: ${check.detail}`).join("\n");
    throw new Error(`Benchmark regression checks failed:\n${detail}`);
  }

  console.log("Benchmark regression checks passed.");
}

function runBenchCommand(args) {
  const result = spawnSync("pnpm", [...args, "--", "--json"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...ciEnv
    }
  });

  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    const stdout = (result.stdout ?? "").trim();
    throw new Error(
      `Benchmark command failed: pnpm ${args.join(" ")}\n${stderr || stdout || "No output"}`
    );
  }

  const lines = (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const jsonLine = [...lines].reverse().find((line) => line.startsWith("{") && line.endsWith("}"));

  if (!jsonLine) {
    throw new Error(`Unable to parse benchmark JSON from command output: pnpm ${args.join(" ")}`);
  }

  return JSON.parse(jsonLine);
}

function runChecks(recorder, pipeline, thresholds) {
  const checks = [];

  checks.push(
    assertCheck(
      "recorder.ringOptimized.throughputOpsPerSec",
      recorder.ringOptimized.throughputOpsPerSec >= thresholds.recorder.ringOptimizedMinOpsPerSec,
      `expected >= ${thresholds.recorder.ringOptimizedMinOpsPerSec}, got ${Math.round(
        recorder.ringOptimized.throughputOpsPerSec
      )}`
    )
  );

  checks.push(
    assertCheck(
      "recorder.recorderIngest.throughputOpsPerSec",
      recorder.recorderIngest.throughputOpsPerSec >= thresholds.recorder.recorderIngestMinOpsPerSec,
      `expected >= ${thresholds.recorder.recorderIngestMinOpsPerSec}, got ${Math.round(
        recorder.recorderIngest.throughputOpsPerSec
      )}`
    )
  );

  checks.push(
    assertCheck(
      "recorder.snapshotLatencyMs",
      recorder.snapshotLatencyMs <= thresholds.recorder.snapshotLatencyMaxMs,
      `expected <= ${thresholds.recorder.snapshotLatencyMaxMs}, got ${recorder.snapshotLatencyMs.toFixed(2)}`
    )
  );

  checks.push(
    assertCheck(
      "pipeline.ingestThroughputOpsPerSec",
      pipeline.ingestThroughputOpsPerSec >= thresholds.pipeline.ingestMinOpsPerSec,
      `expected >= ${thresholds.pipeline.ingestMinOpsPerSec}, got ${Math.round(
        pipeline.ingestThroughputOpsPerSec
      )}`
    )
  );

  checks.push(
    assertCheck(
      "pipeline.fullExportDurationMs",
      pipeline.fullExportDurationMs <= thresholds.pipeline.fullExportMaxMs,
      `expected <= ${thresholds.pipeline.fullExportMaxMs}, got ${pipeline.fullExportDurationMs.toFixed(2)}`
    )
  );

  checks.push(
    assertCheck(
      "pipeline.filteredExportDurationMs",
      pipeline.filteredExportDurationMs <= thresholds.pipeline.filteredExportMaxMs,
      `expected <= ${thresholds.pipeline.filteredExportMaxMs}, got ${pipeline.filteredExportDurationMs.toFixed(
        2
      )}`
    )
  );

  checks.push(
    assertCheck(
      "pipeline.archiveDropRatio",
      pipeline.archiveDropRatio >= thresholds.pipeline.archiveDropRatioMin,
      `expected >= ${thresholds.pipeline.archiveDropRatioMin}, got ${pipeline.archiveDropRatio.toFixed(3)}`
    )
  );

  return checks;
}

function runVolumeChecks(volumes, thresholds) {
  const defaultExport = volumes.defaultExport;

  return [
    assertCheck(
      "pipelineVolumes.ingestThroughputOpsPerSec",
      volumes.ingestThroughputOpsPerSec >= thresholds.ingestMinOpsPerSec,
      `expected >= ${thresholds.ingestMinOpsPerSec}, got ${Math.round(
        volumes.ingestThroughputOpsPerSec
      )}`
    ),
    // Machine-independent: blob writes must not slow down as the session tracks more blobs.
    assertCheck(
      "pipelineVolumes.blobPutLatencyGrowth",
      volumes.blobPutAvgMsLast <= volumes.blobPutAvgMsFirst * thresholds.blobPutLatencyGrowthMax,
      `expected the last blob writes within ${thresholds.blobPutLatencyGrowthMax}x the first, got ${volumes.blobPutAvgMsFirst.toFixed(2)} -> ${volumes.blobPutAvgMsLast.toFixed(2)} ms`
    ),
    assertCheck(
      "pipelineVolumes.defaultExport.durationMs",
      defaultExport.durationMs <= thresholds.defaultExportMaxMs,
      `expected <= ${thresholds.defaultExportMaxMs}, got ${defaultExport.durationMs.toFixed(2)}`
    ),
    assertCheck(
      "pipelineVolumes.defaultExport.peakRssDeltaMb",
      defaultExport.peakRssDeltaMb <= thresholds.defaultExportPeakRssMaxMb,
      `expected <= ${thresholds.defaultExportPeakRssMaxMb}, got ${defaultExport.peakRssDeltaMb.toFixed(1)}`
    ),
    assertCheck(
      "pipelineVolumes.defaultExport.archiveBytes",
      defaultExport.archiveBytes <= DEFAULT_EXPORT_MAX_ARCHIVE_BYTES &&
        defaultExport.archiveEvents > 0,
      `expected a non-empty archive <= ${DEFAULT_EXPORT_MAX_ARCHIVE_BYTES} bytes, got ${defaultExport.archiveBytes} bytes / ${defaultExport.archiveEvents} events`
    )
  ];
}

/**
 * The Player on a long recording (PROPOSAL §12: follow + rail re-render every 120 ms): opening
 * and modelling the archive, the per-archive rail derivations, the per-tick work while playing,
 * and the React re-render per tick (jsdom).
 */
function runPlayerChecks(player, limits) {
  const maxMs = (name, value, limit) =>
    assertCheck(
      `player.${name}`,
      value <= limit,
      `expected <= ${limit} ms, got ${value.toFixed(2)} ms`
    );
  const checks = [
    assertCheck(
      "player.eventCount",
      player.eventCount >= limits.minEvents,
      `the bench archive must be long: expected >= ${limits.minEvents} events, got ${player.eventCount}`
    ),
    maxMs("openMs", player.openMs, limits.openMaxMs),
    maxMs("modelBuildMs", player.modelBuildMs, limits.modelBuildMaxMs),
    maxMs("derivationsMs", player.derivationsMs, limits.derivationsMaxMs),
    maxMs("tickMs.p95", player.tickMs.p95, limits.tickP95MaxMs)
  ];

  if (!player.render) {
    checks.push(
      assertCheck("player.render", false, "the render pass did not run (BENCH_PLAYER_RENDER)")
    );
  } else {
    checks.push(
      assertCheck(
        "player.render.failedPanels",
        player.render.failedPanels.length === 0,
        `panels crashed on the long archive: ${player.render.failedPanels.join(", ")}`
      ),
      maxMs("render.tickP95", player.render.tickP95, limits.renderTickP95MaxMs)
    );
  }

  return checks;
}

function assertCheck(name, ok, detail) {
  return {
    name,
    ok,
    detail
  };
}
