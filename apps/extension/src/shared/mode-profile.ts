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

export type ModeProductProfile = {
  label: string;
  summary: string;
  signals: string;
  heavyCapture: string;
};

export const MODE_PRODUCT_PROFILES: Record<CaptureMode, ModeProductProfile> = {
  lite: {
    label: "Lite",
    summary: "Page-side lightweight signals with browser-side network metadata.",
    signals:
      "click / input / scroll / pointer samples / mutation summary / browser-side network baseline",
    heavyCapture:
      "idle screenshots disabled by default, runtime DOM snapshots stay summary-only, page-side response-body capture disabled"
  },
  full: {
    label: "Full",
    summary:
      "Browser-assisted capture with CDP screenshots, optional tab recording, navigation, and richer diagnostics.",
    signals: "CDP network / navigation / runtime errors plus page-side interaction hints",
    heavyCapture:
      "screenshots stay browser-side, tab recording requires explicit enablement, page-side fetch/xhr hooks remain disabled, body capture stays capped"
  }
};

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

/** Transport defaults (sampling, freeze triggers) before stored options or profiles apply. */
export function resolveModeBaseConfig(mode: CaptureMode): RecorderConfig {
  const base: RecorderConfig = {
    ...DEFAULT_RECORDER_CONFIG,
    mode
  };

  if (mode === "full") {
    return {
      ...base,
      freezeOnNetworkFailure: false,
      freezeOnLongTaskSpike: false,
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
    freezeOnNetworkFailure: false,
    freezeOnLongTaskSpike: false,
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

export function shouldInjectPageHooksForMode(mode: CaptureMode): boolean {
  return mode === "lite" || mode === "full";
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
