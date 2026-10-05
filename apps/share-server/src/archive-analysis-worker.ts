import { parentPort, workerData } from "node:worker_threads";

import { analyzeArchive } from "./archive-analysis.js";
import type {
  ArchiveAnalysisWorkerInput,
  ArchiveAnalysisWorkerMessage
} from "./archive-analysis-runner.js";

const port = parentPort;

if (!port) {
  throw new Error("archive-analysis-worker must run inside a worker thread.");
}

const input = workerData as ArchiveAnalysisWorkerInput;

analyzeArchive(input.bytes, input.limits).then(
  (analysis) => {
    port.postMessage({ ok: true, analysis } satisfies ArchiveAnalysisWorkerMessage);
  },
  (error: unknown) => {
    port.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    } satisfies ArchiveAnalysisWorkerMessage);
  }
);
