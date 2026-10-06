import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  type CaptureMode,
  type CapturePolicy,
  type RecorderConfig
} from "@webblackbox/protocol";

import type { FullModeVisualCapture } from "./messages.js";

/** Default body capture cap for CDP-backed (full) sessions. */
export const FULL_MODE_BODY_CAPTURE_MAX_BYTES = 128 * 1024;

/**
 * The last step of every extension recorder config (v1 options and profiles alike): the
 * network/long-task freeze triggers stay off and the mode's own body and CDP limits apply.
 */
export function applyModeProductBoundary(
  mode: CaptureMode,
  config: RecorderConfig
): RecorderConfig {
  const next: RecorderConfig = {
    ...config,
    mode,
    freezeOnNetworkFailure: false,
    freezeOnLongTaskSpike: false,
    sampling: {
      ...config.sampling
    }
  };

  if (mode === "lite") {
    next.sampling.bodyCaptureMaxBytes = 0;
  }

  if (mode === "full") {
    next.capturePolicy = applyFullModeCapturePolicy(config.capturePolicy);
  }

  return next;
}

/** Transport sampling defaults before stored options or profiles apply. */
export function resolveModeBaseConfig(mode: CaptureMode): RecorderConfig {
  const base: RecorderConfig = {
    ...DEFAULT_RECORDER_CONFIG,
    mode
  };

  if (mode === "full") {
    return {
      ...base,
      sampling: {
        ...base.sampling,
        mousemoveHz: 12,
        scrollHz: 10,
        domFlushMs: 180,
        snapshotIntervalMs: 30_000,
        screenshotIdleMs: 12_000,
        bodyCaptureMaxBytes: FULL_MODE_BODY_CAPTURE_MAX_BYTES
      }
    };
  }

  return {
    ...base,
    sampling: {
      ...base.sampling,
      mousemoveHz: 14,
      scrollHz: 10,
      domFlushMs: 160,
      snapshotIntervalMs: 30_000,
      screenshotIdleMs: base.sampling.screenshotIdleMs,
      bodyCaptureMaxBytes: 0
    }
  };
}

/** Full-mode screenshots / tab recording as picked in the popup (or pinned by a profile). */
export function applyFullModeVisualCapture(
  config: RecorderConfig,
  mode: CaptureMode,
  visualCapture: FullModeVisualCapture | undefined
): RecorderConfig {
  if (mode !== "full" || !visualCapture) {
    return config;
  }

  const basePolicy =
    config.capturePolicy ?? DEFAULT_RECORDER_CONFIG.capturePolicy ?? DEFAULT_CAPTURE_POLICY;
  const screenshots = visualCapture === "screenshots" || visualCapture === "both" ? "allow" : "off";
  const screenRecordings =
    visualCapture === "recording" || visualCapture === "both" ? "allow" : "off";

  return {
    ...config,
    capturePolicy: {
      ...basePolicy,
      categories: {
        ...basePolicy.categories,
        screenshots,
        screenRecordings
      }
    }
  };
}

function applyFullModeCapturePolicy(policy: CapturePolicy | undefined): CapturePolicy {
  const basePolicy = policy ?? DEFAULT_CAPTURE_POLICY;

  return {
    ...basePolicy,
    mode: basePolicy.mode === "lab" ? "lab" : "debug",
    unmaskPolicySource:
      basePolicy.unmaskPolicySource === "none"
        ? "extension-managed"
        : basePolicy.unmaskPolicySource,
    categories: {
      ...basePolicy.categories,
      screenshots: "allow",
      screenRecordings: basePolicy.categories.screenRecordings,
      cdp: basePolicy.categories.cdp === "full" ? "full" : "safe-subset"
    }
  };
}
