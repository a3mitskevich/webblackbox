import type { FreezeReason } from "@webblackbox/protocol";

import type { ExtensionOutboundMessage } from "../shared/messages.js";
import { shouldCaptureAdvancedProfiles } from "./artifacts-profiles.js";
import type { SessionRuntime } from "./session-registry.js";

const FULL_MODE_INCIDENT_CAPTURE_COOLDOWN_MS = 15_000;
const FREEZE_NOTICE_COOLDOWN_MS = 20_000;

type ArtifactCapture = (runtime: SessionRuntime, reason: string) => Promise<void>;

/**
 * The artifact orchestration: which captures an incident, a freeze or a full-mode milestone runs.
 * The captures themselves are injected (screenshot, trace, storage, profiles); the popup notice
 * and the badge are the worker's display side, injected as callbacks.
 */
export type ArtifactsDeps = {
  captureScreenshot: ArtifactCapture;
  captureTraceMetrics: ArtifactCapture;
  captureAdvancedProfiles: ArtifactCapture;
  captureStorageSnapshots: ArtifactCapture;
  captureCookieValues: ArtifactCapture;
  broadcast: (message: ExtensionOutboundMessage) => void;
  setFreezeBadge: () => Promise<void>;
};

export type ArtifactsController = {
  shouldCaptureIncidentArtifacts: (runtime: SessionRuntime) => boolean;
  captureIncidentArtifacts: (runtime: SessionRuntime, reason: string) => Promise<void>;
  captureFullModeArtifacts: (runtime: SessionRuntime, reason: string) => Promise<void>;
  handleFreezeNotice: (runtime: SessionRuntime, reason: FreezeReason) => void;
};

export function createArtifactsController(deps: ArtifactsDeps): ArtifactsController {
  function shouldCaptureIncidentArtifacts(runtime: SessionRuntime): boolean {
    if (runtime.stopping) {
      return false;
    }

    if (
      runtime.config.capturePolicy?.categories.screenshots === "off" &&
      runtime.config.capturePolicy?.categories.cdp !== "full"
    ) {
      return false;
    }

    const now = Date.now();

    if (now - runtime.lastIncidentCaptureAt < FULL_MODE_INCIDENT_CAPTURE_COOLDOWN_MS) {
      return false;
    }

    runtime.lastIncidentCaptureAt = now;
    return true;
  }

  async function captureIncidentArtifacts(runtime: SessionRuntime, reason: string): Promise<void> {
    await Promise.allSettled([
      deps.captureScreenshot(runtime, reason),
      deps.captureTraceMetrics(runtime, reason)
    ]);
  }

  async function captureFullModeArtifacts(runtime: SessionRuntime, reason: string): Promise<void> {
    const tasks: Array<Promise<void>> = [
      deps.captureScreenshot(runtime, reason),
      deps.captureTraceMetrics(runtime, reason)
    ];

    if (reason !== "session-start") {
      // The DOM comes from the page agent's raw snapshot (`dom: allow`), which masks blocked
      // selectors and field values; a CDP DOMSnapshot would carry both unmasked.
      tasks.push(deps.captureStorageSnapshots(runtime, reason));
    } else if (runtime.config.capturePolicy?.categories.cookies === "allow") {
      // Cookie values at the start (and at stop) even when no incident triggers a snapshot.
      tasks.push(deps.captureCookieValues(runtime, reason));
    }

    if (shouldCaptureAdvancedProfiles(reason)) {
      tasks.push(deps.captureAdvancedProfiles(runtime, reason));
    }

    await Promise.allSettled(tasks);
  }

  function handleFreezeNotice(runtime: SessionRuntime, reason: FreezeReason): void {
    if (runtime.stopping) {
      return;
    }

    const now = Date.now();
    const lastNotifiedAt = runtime.lastFreezeNotices.get(reason) ?? Number.NEGATIVE_INFINITY;

    if (now - lastNotifiedAt < FREEZE_NOTICE_COOLDOWN_MS) {
      return;
    }

    runtime.lastFreezeNotices.set(reason, now);
    deps.broadcast({ kind: "sw.freeze", sid: runtime.sid, reason });
    void deps.setFreezeBadge();
  }

  return {
    shouldCaptureIncidentArtifacts,
    captureIncidentArtifacts,
    captureFullModeArtifacts,
    handleFreezeNotice
  };
}
