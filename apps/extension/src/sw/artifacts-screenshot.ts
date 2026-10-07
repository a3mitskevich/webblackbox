import type { RawRecorderEvent } from "@webblackbox/recorder";

import { decodeBase64, sendCdpCommand } from "./artifacts-cdp.js";
import type { SessionRuntime } from "./session-registry.js";

const SCREENSHOT_ACTION_COOLDOWN_MS = 2_000;
const POINTER_STALE_MS = 2_500;
const ACTION_SCREENSHOT_RAW_TYPES = new Set(["click", "dblclick", "submit", "marker"]);

/**
 * What the screenshot capture needs from the service worker: raw-event ingestion and the
 * session-queue limit shared with the enqueue path (action shots stop well before it).
 */
export type ScreenshotArtifactsDeps = {
  ingestRawEvent: (rawEvent: RawRecorderEvent) => void;
  bestEffortQueueMaxPending: number;
};

export type ScreenshotArtifactsController = {
  captureScreenshot: (runtime: SessionRuntime, reason: string) => Promise<void>;
  shouldCaptureActionScreenshot: (rawEvent: RawRecorderEvent, runtime: SessionRuntime) => boolean;
};

export function createScreenshotArtifactsController(
  deps: ScreenshotArtifactsDeps
): ScreenshotArtifactsController {
  async function captureScreenshot(runtime: SessionRuntime, reason: string): Promise<void> {
    if (!runtime.cdpRouter) {
      return;
    }

    if (runtime.config.capturePolicy?.categories.screenshots === "off") {
      return;
    }

    const screenshot = await sendCdpCommand<{ data?: string }>(
      runtime,
      { tabId: runtime.tabId },
      "Page.captureScreenshot",
      {
        format: "webp",
        quality: 62,
        fromSurface: true
      }
    );

    if (!screenshot?.data) {
      return;
    }

    const bytes = decodeBase64(screenshot.data);
    const hash = await runtime.pipeline.putBlob("image/webp", bytes);
    const viewport = runtime.lastViewport;
    const pointer =
      runtime.lastPointer && Date.now() - runtime.lastPointer.t <= POINTER_STALE_MS
        ? runtime.lastPointer
        : null;

    deps.ingestRawEvent({
      source: "system",
      rawType: "cdp.screen.screenshot",
      sid: runtime.sid,
      tabId: runtime.tabId,
      t: Date.now(),
      mono: monotonicTime(),
      payload: {
        shotId: hash,
        format: "webp",
        quality: 62,
        w: viewport?.width,
        h: viewport?.height,
        viewport: viewport
          ? {
              width: viewport.width,
              height: viewport.height,
              dpr: viewport.dpr
            }
          : undefined,
        pointer: pointer
          ? {
              x: pointer.x,
              y: pointer.y,
              t: pointer.t,
              mono: pointer.mono
            }
          : undefined,
        size: bytes.byteLength,
        reason
      }
    });
  }

  function shouldCaptureActionScreenshot(
    rawEvent: RawRecorderEvent,
    runtime: SessionRuntime
  ): boolean {
    if (rawEvent.source !== "content") {
      return false;
    }

    if (!ACTION_SCREENSHOT_RAW_TYPES.has(rawEvent.rawType)) {
      return false;
    }

    if (runtime.config.capturePolicy?.categories.screenshots === "off") {
      return false;
    }

    if (rawEvent.mono - runtime.lastActionScreenshotMono < SCREENSHOT_ACTION_COOLDOWN_MS) {
      return false;
    }

    if (runtime.queueDepth >= Math.floor(deps.bestEffortQueueMaxPending / 3)) {
      return false;
    }

    return true;
  }

  return {
    captureScreenshot,
    shouldCaptureActionScreenshot
  };
}

function monotonicTime(): number {
  if (typeof performance === "undefined") {
    return Date.now();
  }

  return performance.timeOrigin + performance.now();
}
