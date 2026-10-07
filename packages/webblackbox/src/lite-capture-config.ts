import { DEFAULT_POINTER_CAPTURE_OPTIONS, type PointerCaptureOptions } from "@webblackbox/protocol";

import type { LiteCaptureAgentOptions, LiteCaptureSampling } from "./types.js";

export const DEFAULT_SAMPLING: LiteCaptureSampling = {
  mousemoveHz: 20,
  scrollHz: 15,
  domFlushMs: 100,
  snapshotIntervalMs: 20_000,
  screenshotIdleMs: 0
};

export function sanitizeSamplingConfig(raw: unknown): LiteCaptureSampling {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_SAMPLING };
  }

  const row = raw as Record<string, unknown>;

  return {
    mousemoveHz: clampRate(row.mousemoveHz, DEFAULT_SAMPLING.mousemoveHz),
    scrollHz: clampRate(row.scrollHz, DEFAULT_SAMPLING.scrollHz),
    domFlushMs: clampInterval(row.domFlushMs, DEFAULT_SAMPLING.domFlushMs),
    snapshotIntervalMs: clampInterval(row.snapshotIntervalMs, DEFAULT_SAMPLING.snapshotIntervalMs),
    screenshotIdleMs: clampOptionalInterval(row.screenshotIdleMs, DEFAULT_SAMPLING.screenshotIdleMs)
  };
}

export function sanitizePointerOptions(raw: unknown): PointerCaptureOptions {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_POINTER_CAPTURE_OPTIONS };
  }

  const row = raw as Record<string, unknown>;

  return {
    hover: row.hover === true,
    drag: row.drag === true,
    wheel: row.wheel === true
  };
}

function clampRate(value: unknown, fallback: number): number {
  return clampNumber(value, fallback, 1, 240);
}

function clampInterval(value: unknown, fallback: number): number {
  return clampNumber(value, fallback, 25, 120_000);
}

function clampOptionalInterval(value: unknown, fallback: number): number {
  if (value === 0) {
    return 0;
  }

  return clampNumber(value, fallback, 0, 120_000);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
}

export function monotonicTime(): number {
  return performance.timeOrigin + performance.now();
}

export function resolveContentFrameContext(scope: LiteCaptureAgentOptions["frameScope"] = "auto"): {
  marker: string | undefined;
  isTopLevel: boolean;
} {
  if (scope === "top") {
    return {
      marker: undefined,
      isTopLevel: true
    };
  }

  if (scope === "child") {
    return {
      marker: "content-iframe",
      isTopLevel: false
    };
  }

  try {
    if (window.top === window) {
      return {
        marker: undefined,
        isTopLevel: true
      };
    }
  } catch {
    return {
      marker: "content-iframe",
      isTopLevel: false
    };
  }

  return {
    marker: "content-iframe",
    isTopLevel: false
  };
}
