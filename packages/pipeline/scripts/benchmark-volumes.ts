/**
 * Pipeline benchmark at real volumes: a long Full-mode session (100k events, 2k blobs of
 * 100–500 KB) written through the extension's storage stack (at-rest encryption over
 * IndexedDB, here fake-indexeddb), then exported with the default export policy the way the
 * offscreen document does it (archive → Blob). Reports ingest throughput, blob write latency
 * and the export's duration and peak memory.
 */
import "fake-indexeddb/auto";

import { performance } from "node:perf_hooks";

import type {
  PrivacyClassification,
  PrivacyDataCategory,
  SessionMetadata,
  WebBlackboxEvent
} from "@webblackbox/protocol";

import {
  EncryptedPipelineStorage,
  FlightRecorderPipeline,
  generatePipelineStorageKeyBytes,
  importPipelineStorageKey,
  IndexedDbPipelineStorage,
  readWebBlackboxArchive
} from "../src/index.js";

const DEFAULT_EVENT_COUNT = 100_000;
const DEFAULT_BLOB_COUNT = 2_000;
const DEFAULT_BLOB_MIN_KB = 100;
const DEFAULT_BLOB_MAX_KB = 500;
// One blob in four is a response body (kept by the default export policy); the rest are
// screenshots, which the default policy leaves out.
const BODY_BLOB_SHARE = 4;
const EVENT_STEP_MS = 18;
const MEMORY_SAMPLE_INTERVAL_MS = 5;
const BLOB_LATENCY_WINDOW = 100;
const RANDOM_FILL_LIMIT = 65_536;
const BENCHMARK_PASSPHRASE = "benchmark-passphrase";
const MB = 1024 * 1024;

type MemorySample = {
  rss: number;
  heapUsed: number;
  arrayBuffers: number;
};

type ExportMeasurement = {
  durationMs: number;
  archiveBytes: number;
  archiveEvents: number;
  peakRssDeltaMb: number;
  peakHeapUsedDeltaMb: number;
  peakArrayBuffersDeltaMb: number;
};

type ExportOptions = Parameters<FlightRecorderPipeline["exportBundle"]>[0];

export type PipelineVolumeBenchmarkReport = {
  eventCount: number;
  blobCount: number;
  bodyBlobCount: number;
  screenshotBlobCount: number;
  blobBytesTotalMb: number;
  sessionEventBytesMb: number;
  chunkCount: number;
  ingestDurationMs: number;
  ingestThroughputOpsPerSec: number;
  blobPutAvgMsFirst: number;
  blobPutAvgMsLast: number;
  defaultExport: ExportMeasurement;
  fullExport: ExportMeasurement | null;
};

type BlobPlan = {
  kind: "body" | "screenshot";
  size: number;
};

type BlobRef = BlobPlan & {
  hash: string;
};

const WORDS = [
  "checkout",
  "cart",
  "payment",
  "profile",
  "search",
  "catalog",
  "inventory",
  "shipping",
  "invoice",
  "session",
  "render",
  "timeout",
  "retry",
  "widget",
  "dashboard",
  "filter",
  "report",
  "export",
  "upload",
  "preview"
];

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = Number(raw);

  if (!raw || !Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function toMb(bytes: number): number {
  return bytes / MB;
}

function word(index: number): string {
  return WORDS[index % WORDS.length] ?? "item";
}

function collectGarbage(): void {
  (globalThis as { gc?: () => void }).gc?.();
}

function readMemory(): MemorySample {
  const usage = process.memoryUsage();
  return { rss: usage.rss, heapUsed: usage.heapUsed, arrayBuffers: usage.arrayBuffers };
}

/** Samples memory on a timer while `task` runs; returns the peak above the starting point. */
async function measurePeakMemory<T>(task: () => Promise<T>): Promise<{
  result: T;
  durationMs: number;
  peak: MemorySample;
}> {
  collectGarbage();
  const baseline = readMemory();
  const peak: MemorySample = { ...baseline };
  const sample = (): void => {
    const current = readMemory();
    peak.rss = Math.max(peak.rss, current.rss);
    peak.heapUsed = Math.max(peak.heapUsed, current.heapUsed);
    peak.arrayBuffers = Math.max(peak.arrayBuffers, current.arrayBuffers);
  };
  const timer = setInterval(sample, MEMORY_SAMPLE_INTERVAL_MS);
  const startedAt = performance.now();

  try {
    const result = await task();
    sample();
    return {
      result,
      durationMs: performance.now() - startedAt,
      peak: {
        rss: peak.rss - baseline.rss,
        heapUsed: peak.heapUsed - baseline.heapUsed,
        arrayBuffers: peak.arrayBuffers - baseline.arrayBuffers
      }
    };
  } finally {
    clearInterval(timer);
  }
}

function planBlobs(count: number, minKb: number, maxKb: number): BlobPlan[] {
  const spanKb = Math.max(1, maxKb - minKb + 1);

  return Array.from({ length: count }, (_, index) => ({
    kind: index % BODY_BLOB_SHARE === 0 ? "body" : "screenshot",
    size: (minKb + ((index * 7_919) % spanKb)) * 1024
  }));
}

function createScreenshotBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);

  for (let offset = 0; offset < size; offset += RANDOM_FILL_LIMIT) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(size, offset + RANDOM_FILL_LIMIT)));
  }

  return bytes;
}

function createBodyBytes(size: number, seed: number): Uint8Array {
  const parts: string[] = ['{"items":['];
  let length = parts[0]?.length ?? 0;
  let item = 0;

  while (length < size) {
    const id = seed * 100_000 + item;
    const minute = String(id % 60).padStart(2, "0");
    const part =
      `{"id":${id},"sku":"SKU-${id % 9_973}","name":"Item ${id} ${word(id)}",` +
      `"price":${(id % 5_000) / 100},"stock":${id % 97},"tags":["${word(id + 3)}","${word(id + 11)}"],` +
      `"updatedAt":"2026-10-0${(id % 9) + 1}T10:${minute}:00Z"},`;
    parts.push(part);
    length += part.length;
    item += 1;
  }

  return new TextEncoder().encode(parts.join("")).subarray(0, size);
}

function createPrivacy(category: PrivacyDataCategory, high = false): PrivacyClassification {
  return { category, sensitivity: high ? "high" : "low", redacted: true };
}

function describeAction(index: number): string {
  const words: string[] = [];

  for (let offset = 0; offset < 24; offset += 1) {
    words.push(word(index * 7 + offset * 13));
  }

  return `${words.join(" ")} #${index % 4_096} user-${index % 512}`;
}

function createEvent(
  sid: string,
  index: number,
  timestamp: number,
  blobRef: BlobRef | null
): WebBlackboxEvent {
  const base = { v: 1 as const, sid, tab: 1, t: timestamp, mono: index * EVENT_STEP_MS };

  if (blobRef?.kind === "screenshot") {
    return {
      ...base,
      type: "screen.screenshot",
      id: `E-shot-${index}`,
      privacy: createPrivacy("screenshots", true),
      data: { shotId: blobRef.hash, format: "webp", size: blobRef.size, w: 1280, h: 800 }
    };
  }

  const reqId = `R-${Math.floor(index / 2)}`;

  if (blobRef?.kind === "body" || index % 4 === 1) {
    return {
      ...base,
      type: "network.response",
      id: `E-res-${index}`,
      privacy: createPrivacy("network"),
      data: {
        reqId,
        status: index % 23 === 0 ? 500 : 200,
        statusText: "OK",
        mimeType: "application/json",
        duration: 40 + (index % 90),
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        ...(blobRef ? { bodyHash: blobRef.hash, bodySize: blobRef.size } : {})
      }
    };
  }

  if (index % 4 === 0) {
    return {
      ...base,
      type: "network.request",
      id: `E-req-${index}`,
      privacy: createPrivacy("network"),
      data: {
        reqId,
        method: index % 3 === 0 ? "POST" : "GET",
        url: `https://shop.example.test/api/v1/${word(index)}/${index % 5_000}?page=${index % 37}`,
        headers: { accept: "application/json", "x-request-id": `rq-${index}` },
        ...(index % 3 === 0 ? { postData: describeAction(index) } : {})
      }
    };
  }

  if (index % 4 === 2) {
    const isError = index % 41 === 0;

    return {
      ...base,
      type: "console.entry",
      id: `E-log-${index}`,
      ...(isError ? { lvl: "error" as const } : {}),
      privacy: createPrivacy("console"),
      data: { level: isError ? "error" : "log", text: describeAction(index), source: "app" }
    };
  }

  return {
    ...base,
    type: "user.click",
    id: `E-click-${index}`,
    privacy: createPrivacy("actions"),
    data: {
      selector: `#${word(index)}-button-${index % 64}`,
      x: index % 1_400,
      y: index % 900,
      text: describeAction(index).slice(0, 48)
    }
  };
}

async function createStorage(): Promise<EncryptedPipelineStorage> {
  const key = await importPipelineStorageKey(generatePipelineStorageKeyBytes());
  return new EncryptedPipelineStorage(
    new IndexedDbPipelineStorage(`webblackbox-volume-bench-${Date.now()}`),
    { key }
  );
}

/** The offscreen document hands the archive to the download as a Blob. */
async function exportToBlob(
  pipeline: FlightRecorderPipeline,
  options: ExportOptions
): Promise<Blob> {
  const exported = await pipeline.exportBundle(options);
  return new Blob([exported.bytes as BlobPart], { type: "application/zip" });
}

async function measureExport(
  pipeline: FlightRecorderPipeline,
  options: ExportOptions
): Promise<ExportMeasurement> {
  const measured = await measurePeakMemory(() => exportToBlob(pipeline, options));
  const blob = measured.result;
  const parsed = await readWebBlackboxArchive(new Uint8Array(await blob.arrayBuffer()), {
    passphrase: BENCHMARK_PASSPHRASE
  });

  return {
    durationMs: measured.durationMs,
    archiveBytes: blob.size,
    archiveEvents: parsed.events.length,
    peakRssDeltaMb: toMb(measured.peak.rss),
    peakHeapUsedDeltaMb: toMb(measured.peak.heapUsed),
    peakArrayBuffersDeltaMb: toMb(measured.peak.arrayBuffers)
  };
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function run(): Promise<void> {
  const eventCount = readPositiveInt("BENCH_VOLUME_EVENTS", DEFAULT_EVENT_COUNT);
  const blobCount = readPositiveInt("BENCH_VOLUME_BLOBS", DEFAULT_BLOB_COUNT);
  const blobMinKb = readPositiveInt("BENCH_VOLUME_BLOB_MIN_KB", DEFAULT_BLOB_MIN_KB);
  const blobMaxKb = readPositiveInt("BENCH_VOLUME_BLOB_MAX_KB", DEFAULT_BLOB_MAX_KB);
  const includeFullExport = process.env.BENCH_VOLUME_FULL_EXPORT === "1";
  const blobs = planBlobs(blobCount, blobMinKb, blobMaxKb);
  const blobEvery = Math.max(1, Math.floor(eventCount / Math.max(1, blobCount)));
  const storage = await createStorage();
  const startedAt = Date.now() - eventCount * EVENT_STEP_MS;
  const session: SessionMetadata = {
    sid: `S-volume-bench-${Date.now()}`,
    tabId: 1,
    startedAt,
    endedAt: startedAt + eventCount * EVENT_STEP_MS,
    mode: "full",
    url: "https://shop.example.test/checkout",
    title: "Pipeline Volume Benchmark",
    tags: ["benchmark"]
  };
  const pipeline = new FlightRecorderPipeline({ session, storage, maxChunkBytes: 512 * 1024 });

  await pipeline.start();

  const blobPutMs: number[] = [];
  const written: BlobPlan[] = [];
  const ingestStart = performance.now();

  for (let index = 0; index < eventCount; index += 1) {
    const plan = index % blobEvery === 0 ? blobs[written.length] : undefined;
    let blobRef: BlobRef | null = null;

    if (plan) {
      const isBody = plan.kind === "body";
      const bytes = isBody
        ? createBodyBytes(plan.size, written.length)
        : createScreenshotBytes(plan.size);
      const putStart = performance.now();
      const hash = await pipeline.putBlob(isBody ? "application/json" : "image/webp", bytes);
      blobPutMs.push(performance.now() - putStart);
      blobRef = { ...plan, hash };
      written.push(plan);
    }

    await pipeline.ingest(
      createEvent(session.sid, index, startedAt + index * EVENT_STEP_MS, blobRef)
    );
  }

  await pipeline.flush();
  const ingestMs = performance.now() - ingestStart;
  const chunkMetas = (await storage.listChunks(session.sid)).map((chunk) => chunk.meta);

  const defaultExport = await measureExport(pipeline, { passphrase: BENCHMARK_PASSPHRASE });
  const fullExport = includeFullExport
    ? await measureExport(pipeline, {
        passphrase: BENCHMARK_PASSPHRASE,
        includeScreenshots: true,
        includeScreenRecordings: true,
        maxArchiveBytes: null,
        recentWindowMs: null
      })
    : null;

  const report: PipelineVolumeBenchmarkReport = {
    eventCount,
    blobCount: written.length,
    bodyBlobCount: written.filter((blob) => blob.kind === "body").length,
    screenshotBlobCount: written.filter((blob) => blob.kind === "screenshot").length,
    blobBytesTotalMb: toMb(written.reduce((sum, blob) => sum + blob.size, 0)),
    sessionEventBytesMb: toMb(chunkMetas.reduce((sum, meta) => sum + meta.byteLength, 0)),
    chunkCount: chunkMetas.length,
    ingestDurationMs: ingestMs,
    ingestThroughputOpsPerSec: eventCount / Math.max(ingestMs / 1000, 0.000_001),
    blobPutAvgMsFirst: average(blobPutMs.slice(0, BLOB_LATENCY_WINDOW)),
    blobPutAvgMsLast: average(blobPutMs.slice(-BLOB_LATENCY_WINDOW)),
    defaultExport,
    fullExport
  };

  if (process.argv.includes("--json") || process.env.BENCH_OUTPUT === "json") {
    console.log(JSON.stringify(report));
    return;
  }

  console.log("WebBlackbox Pipeline Volume Benchmark");
  console.log("-------------------------------------");
  console.log(JSON.stringify(report, null, 2));
}

run().catch((error) => {
  console.error("Pipeline volume benchmark failed.");
  console.error(error);
  process.exitCode = 1;
});
