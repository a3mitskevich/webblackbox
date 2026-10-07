import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, type WorkerOptions } from "node:worker_threads";

import type { ArchiveLoadLimits } from "@webblackbox/player-sdk";

import {
  createFailedEnvelopeSummary,
  createUnavailableShareSummary,
  type ArchiveAnalysis
} from "./archive-analysis.js";
import { redactText } from "./text.js";

export type ArchiveAnalysisRunOptions = {
  limits: ArchiveLoadLimits;
  timeoutMs: number;
  maxHeapMb: number;
};

export type ArchiveAnalysisWorkerInput = {
  bytes: Uint8Array;
  limits: ArchiveLoadLimits;
};

export type ArchiveAnalysisWorkerMessage =
  { ok: true; analysis: ArchiveAnalysis } | { ok: false; error: string };

// Resolves next to the running module: `.ts` under tsx, `.js` in the tsup build.
const WORKER_URL = new URL(
  `./archive-analysis-worker${extname(fileURLToPath(import.meta.url))}`,
  import.meta.url
);

/**
 * Analyzes an uploaded archive in a worker thread with a V8 heap cap and a wall-clock timeout,
 * so a hostile archive cannot exhaust the server's memory or stall its event loop. ZIP and
 * codec output (ArrayBuffers, outside the V8 heap) stay bounded by `limits`.
 * Never rejects: worker failures resolve to an analysis with `rejectReason` set.
 */
export function runArchiveAnalysis(
  bytes: Uint8Array,
  options: ArchiveAnalysisRunOptions
): Promise<ArchiveAnalysis> {
  return new Promise<ArchiveAnalysis>((resolve) => {
    const input: ArchiveAnalysisWorkerInput = { bytes, limits: options.limits };
    let settled = false;
    let worker: Worker;

    const finish = (analysis: ArchiveAnalysis): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(analysis);
    };
    const fail = (reason: string): void => finish(createRejectedAnalysis(reason));
    const timer = setTimeout(() => {
      fail(`Archive analysis timed out after ${options.timeoutMs} ms.`);
    }, options.timeoutMs);

    try {
      worker = createAnalysisWorker({
        workerData: input,
        resourceLimits: { maxOldGenerationSizeMb: options.maxHeapMb }
      });
    } catch (error) {
      clearTimeout(timer);
      resolve(createRejectedAnalysis(`Archive analysis could not start: ${describeError(error)}`));
      return;
    }

    worker.once("message", (message: unknown) => {
      if (!isWorkerMessage(message)) {
        fail("Archive analysis failed: invalid worker response.");
        return;
      }

      if (message.ok) {
        finish(message.analysis);
        return;
      }

      fail(`Archive analysis failed: ${message.error}`);
    });
    worker.once("error", (error) => {
      fail(
        isWorkerOutOfMemoryError(error)
          ? `Archive analysis exceeded the ${options.maxHeapMb} MB memory limit.`
          : `Archive analysis failed: ${describeError(error)}`
      );
    });
    worker.once("exit", (code) => {
      fail(`Archive analysis worker exited unexpectedly (code ${code}).`);
    });
  });
}

function createAnalysisWorker(options: WorkerOptions): Worker {
  if (!WORKER_URL.pathname.endsWith(".ts")) {
    return new Worker(WORKER_URL, options);
  }

  // Source mode (tsx dev server and tests): tsx's loader hooks are not inherited by worker
  // threads, so register them inside the worker before importing the TypeScript entry.
  const tsxApiUrl = import.meta.resolve("tsx/esm/api");
  const bootstrap =
    `import(${JSON.stringify(tsxApiUrl)})` +
    `.then((tsx) => { tsx.register(); return import(${JSON.stringify(WORKER_URL.href)}); });`;

  return new Worker(bootstrap, { ...options, eval: true });
}

function createRejectedAnalysis(rawReason: string): ArchiveAnalysis {
  const reason = redactText(rawReason, 240);
  return {
    envelope: createFailedEnvelopeSummary(reason),
    summary: createUnavailableShareSummary(false, reason),
    rejectReason: reason
  };
}

function isWorkerMessage(value: unknown): value is ArchiveAnalysisWorkerMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { ok?: unknown }).ok === "boolean"
  );
}

function isWorkerOutOfMemoryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ERR_WORKER_OUT_OF_MEMORY"
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
