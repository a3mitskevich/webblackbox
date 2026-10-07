import type { RawRecorderEvent } from "@webblackbox/recorder";

import type { ScreenshotArtifactsController } from "./artifacts-screenshot.js";
import { readContentScriptRecord, type FullCdpController } from "./full-cdp.js";
import {
  materializeLiteContentEvent,
  shouldMaterializeLiteContentEvent
} from "./lite-materialize.js";
import type { SessionRuntime } from "./session-registry.js";
import { resolveRawEventSession } from "./session-routing.js";
import { SCRIPT_RAW_TYPE } from "./source-maps.js";
import { shouldAllowStopDrainContentEvent } from "./stop-drain.js";

export type PipelineIngestDeps = {
  byTab: ReadonlyMap<number, SessionRuntime>;
  bySid: ReadonlyMap<string, SessionRuntime>;
  enqueue: (
    runtime: SessionRuntime,
    task: () => Promise<void>,
    options?: { bestEffort?: boolean }
  ) => boolean;
  /** Late bindings: both controllers receive `ingestRawEvent` when they are constructed. */
  getFullCdp: () => Pick<FullCdpController, "recordScriptSourceMap">;
  getScreenshotArtifacts: () => Pick<
    ScreenshotArtifactsController,
    "shouldCaptureActionScreenshot" | "captureScreenshot"
  >;
};

export type PipelineIngest = {
  ingestRawEvent: (rawEvent: RawRecorderEvent, options?: { arrivedBeforeStop?: boolean }) => void;
};

const POINTER_TRACKING_RAW_TYPES = new Set([
  "mousemove",
  "click",
  "dblclick",
  "pointerdown",
  "pointerup",
  "contextmenu",
  "auxclick"
]);

/**
 * The single entry point every recorded event crosses: it resolves the owning session, stamps the
 * sid, tracks pointer/viewport state for screenshots, and routes the event to source-map
 * recording, lite materialization, or straight into the session recorder.
 */
export function createPipelineIngest(deps: PipelineIngestDeps): PipelineIngest {
  /**
   * `arrivedBeforeStop`: the event reached the service worker while recording and only waited in
   * the ordered CDP chain, so a stop in the meantime must not drop it.
   */
  function ingestRawEvent(
    rawEvent: RawRecorderEvent,
    options: { arrivedBeforeStop?: boolean } = {}
  ): void {
    const runtime = resolveRawEventSession(rawEvent, deps.byTab, deps.bySid);

    if (!runtime) {
      return;
    }

    if (
      runtime.stopping &&
      rawEvent.source !== "system" &&
      !options.arrivedBeforeStop &&
      !shouldAllowStopDrainContentEvent(runtime, rawEvent)
    ) {
      return;
    }

    if (rawEvent.source === "content" && rawEvent.rawType === SCRIPT_RAW_TYPE) {
      deps.getFullCdp().recordScriptSourceMap(runtime, readContentScriptRecord(rawEvent.payload));
      return;
    }

    const nextRawEvent: RawRecorderEvent = {
      ...rawEvent,
      sid: runtime.sid
    };

    updateRuntimeInteractionState(runtime, nextRawEvent);

    if (shouldMaterializeLiteContentEvent(runtime, nextRawEvent)) {
      deps.enqueue(runtime, async () => {
        const materialized = await materializeLiteContentEvent(runtime, nextRawEvent);

        if (!materialized) {
          return;
        }

        runtime.recorder.ingest(materialized);
      });

      return;
    }

    if (
      runtime.mode === "full" &&
      deps.getScreenshotArtifacts().shouldCaptureActionScreenshot(nextRawEvent, runtime)
    ) {
      runtime.lastActionScreenshotMono = nextRawEvent.mono;
      deps.enqueue(
        runtime,
        async () => {
          await deps
            .getScreenshotArtifacts()
            .captureScreenshot(runtime, `action:${nextRawEvent.rawType}`);
        },
        { bestEffort: true }
      );
    }

    runtime.recorder.ingest(nextRawEvent);
  }

  function updateRuntimeInteractionState(
    runtime: SessionRuntime,
    rawEvent: RawRecorderEvent
  ): void {
    if (rawEvent.source !== "content") {
      return;
    }

    const payload = asRecord(rawEvent.payload);

    if (!payload) {
      return;
    }

    if (rawEvent.rawType === "resize") {
      const width = asFiniteNumber(payload.width);
      const height = asFiniteNumber(payload.height);
      const dpr = asFiniteNumber(payload.dpr) ?? runtime.lastViewport?.dpr ?? 1;

      if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
        runtime.lastViewport = {
          width: Math.round(width),
          height: Math.round(height),
          dpr: Number(dpr.toFixed(2))
        };
      }

      return;
    }

    if (POINTER_TRACKING_RAW_TYPES.has(rawEvent.rawType)) {
      const x = asFiniteNumber(payload.x);
      const y = asFiniteNumber(payload.y);

      if (typeof x === "number" && typeof y === "number") {
        runtime.lastPointer = {
          x: Number(x.toFixed(2)),
          y: Number(y.toFixed(2)),
          t: rawEvent.t,
          mono: rawEvent.mono
        };
      }
    }
  }

  return { ingestRawEvent };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
