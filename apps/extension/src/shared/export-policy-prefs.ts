import type { ExportPolicy } from "@webblackbox/protocol";

import type { FullModeVisualCapture } from "./messages.js";

/**
 * Archive export preferences (size cap, recent window). Edited on the options page, read by the
 * popup and the sessions page when they export. Extension pages share one origin, so
 * `localStorage` is common to both; the key predates the move out of the popup.
 */
export const EXPORT_POLICY_PREFS_STORAGE_KEY = "webblackbox.popup.export-policy";

export const ARCHIVE_SIZE_MB_LIMITS = { min: 1, max: 4096 } as const;
export const RECENT_WINDOW_MINUTES_LIMITS = { min: 1, max: 43_200 } as const;

const BYTES_PER_MB = 1024 * 1024;
const MS_PER_MINUTE = 60 * 1000;
/** Stored prefs carry this version; records without one predate the whole-session default. */
const EXPORT_POLICY_PREFS_VERSION = 2;

/** `0` turns a limit off: no size cap, no recent window. */
export type ExportPolicyPrefs = {
  maxArchiveMb: number;
  recentMinutes: number;
};

/** The whole session: no size cap and no recent window unless the user sets one. */
export const DEFAULT_EXPORT_POLICY_PREFS: ExportPolicyPrefs = {
  maxArchiveMb: 0,
  recentMinutes: 0
};

/** The defaults before the whole-session export: kept only when the user chose them. */
export const LEGACY_DEFAULT_EXPORT_POLICY_PREFS: ExportPolicyPrefs = {
  maxArchiveMb: 100,
  recentMinutes: 20
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
  const record = asRecord(raw);

  return {
    maxArchiveMb: toLimit(
      record.maxArchiveMb,
      DEFAULT_EXPORT_POLICY_PREFS.maxArchiveMb,
      ARCHIVE_SIZE_MB_LIMITS
    ),
    recentMinutes: toLimit(
      record.recentMinutes,
      DEFAULT_EXPORT_POLICY_PREFS.recentMinutes,
      RECENT_WINDOW_MINUTES_LIMITS
    )
  };
}

/**
 * Reads prefs written before the whole-session default (no `version`). There, a missing or
 * invalid field meant the old default, and a field equal to the old default was most likely
 * never chosen: such fields become "off"; values the user set are kept.
 */
export function migrateLegacyExportPolicyPrefs(raw: unknown): ExportPolicyPrefs {
  const record = asRecord(raw);
  const legacy = {
    maxArchiveMb: toLimit(
      record.maxArchiveMb,
      LEGACY_DEFAULT_EXPORT_POLICY_PREFS.maxArchiveMb,
      ARCHIVE_SIZE_MB_LIMITS
    ),
    recentMinutes: toLimit(
      record.recentMinutes,
      LEGACY_DEFAULT_EXPORT_POLICY_PREFS.recentMinutes,
      RECENT_WINDOW_MINUTES_LIMITS
    )
  };

  return {
    maxArchiveMb:
      legacy.maxArchiveMb === LEGACY_DEFAULT_EXPORT_POLICY_PREFS.maxArchiveMb
        ? DEFAULT_EXPORT_POLICY_PREFS.maxArchiveMb
        : legacy.maxArchiveMb,
    recentMinutes:
      legacy.recentMinutes === LEGACY_DEFAULT_EXPORT_POLICY_PREFS.recentMinutes
        ? DEFAULT_EXPORT_POLICY_PREFS.recentMinutes
        : legacy.recentMinutes
  };
}

/** Loads the prefs; legacy records are migrated once and written back in the current format. */
export function loadExportPolicyPrefs(
  storage: StorageLike | undefined = defaultStorage()
): ExportPolicyPrefs {
  try {
    const raw = storage?.getItem(EXPORT_POLICY_PREFS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : undefined;

    if (parsed === undefined || asRecord(parsed).version === EXPORT_POLICY_PREFS_VERSION) {
      return normalizeExportPolicyPrefs(parsed);
    }

    const migrated = migrateLegacyExportPolicyPrefs(parsed);
    saveExportPolicyPrefs(migrated, storage);
    return migrated;
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
      JSON.stringify({ version: EXPORT_POLICY_PREFS_VERSION, ...normalizeExportPolicyPrefs(prefs) })
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
    maxArchiveBytes: normalized.maxArchiveMb > 0 ? normalized.maxArchiveMb * BYTES_PER_MB : null,
    recentWindowMs: normalized.recentMinutes > 0 ? normalized.recentMinutes * MS_PER_MINUTE : null
  };
}

/** True when an export keeps the whole session (no size cap, no recent window). */
export function exportsWholeSession(prefs: ExportPolicyPrefs): boolean {
  const normalized = normalizeExportPolicyPrefs(prefs);
  return normalized.maxArchiveMb === 0 && normalized.recentMinutes === 0;
}

/** A limit in its unit: `0` (off) is kept, anything else invalid falls back, the rest is clamped. */
function toLimit(
  value: unknown,
  fallback: number,
  limits: { readonly min: number; readonly max: number }
): number {
  const numeric =
    typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;

  if (numeric === 0) {
    return 0;
  }

  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }

  return Math.max(limits.min, Math.min(limits.max, Math.round(numeric)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
