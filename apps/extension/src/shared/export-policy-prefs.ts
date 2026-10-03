import { DEFAULT_EXPORT_POLICY, type ExportPolicy } from "@webblackbox/protocol";

import type { FullModeVisualCapture } from "./messages.js";

/**
 * Archive export preferences (sensitive-finding alerts, size cap, recent window). Edited on the
 * options page, read by the popup when it exports. Extension pages share one origin, so
 * `localStorage` is common to both; the key predates the move out of the popup.
 */
export const EXPORT_POLICY_PREFS_STORAGE_KEY = "webblackbox.popup.export-policy";

export const ARCHIVE_SIZE_MB_LIMITS = { min: 1, max: 4096 } as const;
export const RECENT_WINDOW_MINUTES_LIMITS = { min: 1, max: 43_200 } as const;

const BYTES_PER_MB = 1024 * 1024;
const MS_PER_MINUTE = 60 * 1000;

export type ExportPolicyPrefs = {
  alertSensitiveFindings: boolean;
  maxArchiveMb: number;
  recentMinutes: number;
};

export const DEFAULT_EXPORT_POLICY_PREFS: ExportPolicyPrefs = {
  alertSensitiveFindings: true,
  maxArchiveMb: Math.round(DEFAULT_EXPORT_POLICY.maxArchiveBytes / BYTES_PER_MB),
  recentMinutes: Math.round(DEFAULT_EXPORT_POLICY.recentWindowMs / MS_PER_MINUTE)
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/** Accepts stored numbers or numeric strings (older popup drafts); clamps to the limits. */
export function normalizeExportPolicyPrefs(raw: unknown): ExportPolicyPrefs {
  const record = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  return {
    alertSensitiveFindings:
      typeof record.alertSensitiveFindings === "boolean"
        ? record.alertSensitiveFindings
        : DEFAULT_EXPORT_POLICY_PREFS.alertSensitiveFindings,
    maxArchiveMb: toBoundedInt(
      record.maxArchiveMb,
      DEFAULT_EXPORT_POLICY_PREFS.maxArchiveMb,
      ARCHIVE_SIZE_MB_LIMITS
    ),
    recentMinutes: toBoundedInt(
      record.recentMinutes,
      DEFAULT_EXPORT_POLICY_PREFS.recentMinutes,
      RECENT_WINDOW_MINUTES_LIMITS
    )
  };
}

export function loadExportPolicyPrefs(
  storage: StorageLike | undefined = defaultStorage()
): ExportPolicyPrefs {
  try {
    const raw = storage?.getItem(EXPORT_POLICY_PREFS_STORAGE_KEY);
    return normalizeExportPolicyPrefs(raw ? JSON.parse(raw) : undefined);
  } catch {
    return { ...DEFAULT_EXPORT_POLICY_PREFS };
  }
}

/** Returns false when the browser refused the write (quota, disabled storage). */
export function saveExportPolicyPrefs(
  prefs: ExportPolicyPrefs,
  storage: StorageLike | undefined = defaultStorage()
): boolean {
  if (!storage) {
    return false;
  }

  try {
    storage.setItem(
      EXPORT_POLICY_PREFS_STORAGE_KEY,
      JSON.stringify(normalizeExportPolicyPrefs(prefs))
    );
    return true;
  } catch {
    return false;
  }
}

/** Export policy for a session; visuals follow the full-mode visual capture choice. */
export function toExportPolicy(
  prefs: ExportPolicyPrefs,
  visualCapture: FullModeVisualCapture
): ExportPolicy {
  const normalized = normalizeExportPolicyPrefs(prefs);

  return {
    includeScreenshots: visualCapture === "screenshots" || visualCapture === "both",
    includeScreenRecordings: visualCapture === "recording" || visualCapture === "both",
    maxArchiveBytes: normalized.maxArchiveMb * BYTES_PER_MB,
    recentWindowMs: normalized.recentMinutes * MS_PER_MINUTE
  };
}

function toBoundedInt(
  value: unknown,
  fallback: number,
  limits: { readonly min: number; readonly max: number }
): number {
  const numeric =
    typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;

  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }

  return Math.max(limits.min, Math.min(limits.max, Math.round(numeric)));
}
