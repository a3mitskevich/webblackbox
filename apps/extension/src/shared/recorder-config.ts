import { type CaptureMode, type RecorderConfig } from "@webblackbox/protocol";

import { applyModeProductBoundary } from "./mode-profile.js";

export function resolveModeRecorderConfig(
  mode: CaptureMode,
  baseConfig: RecorderConfig,
  storedValue: unknown
): RecorderConfig {
  const stored = asRecord(storedValue);

  if (!stored) {
    return applyModeProductBoundary(mode, baseConfig);
  }

  const mergedConfig: RecorderConfig = {
    ...baseConfig,
    ...stored,
    mode,
    sampling: {
      ...baseConfig.sampling,
      ...(asRecord(stored.sampling) ?? {})
    },
    redaction: {
      ...baseConfig.redaction,
      ...(asRecord(stored.redaction) ?? {})
    },
    sitePolicies: Array.isArray(stored.sitePolicies)
      ? (stored.sitePolicies as RecorderConfig["sitePolicies"])
      : baseConfig.sitePolicies
  };

  return applyModeProductBoundary(mode, mergedConfig);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
