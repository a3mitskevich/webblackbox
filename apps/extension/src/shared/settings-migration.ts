import {
  normalizePerformanceBudget,
  PERFORMANCE_BUDGET_STORAGE_KEY
} from "./performance-budget.js";
import { PROFILES_STORAGE_KEY } from "./profiles/model.js";
import { migrateStoreToBuiltInPresets } from "./profiles/preset-migration.js";
import {
  migrateLegacyOptionsToProfiles,
  parseProfilesStore,
  serializeProfilesStore
} from "./profiles/storage.js";

/** v1 options. Only this migration still reads the key; it is removed once migrated. */
export const LEGACY_OPTIONS_STORAGE_KEY = "webblackbox.options";
/** Layout version of the settings in `chrome.storage.local`. */
export const SETTINGS_VERSION_STORAGE_KEY = "webblackbox.settingsVersion";
/**
 * 1: v1 options folded into the profiles store and the performance budget key.
 * 2: the built-in profiles became Maximum and Light (Default, Full and QA removed).
 */
export const SETTINGS_VERSION = 2;
const LEGACY_OPTIONS_SETTINGS_VERSION = 1;
/** A stored profiles store that failed validation, kept aside when the migration replaces it. */
export const REJECTED_PROFILES_STORAGE_KEY = "webblackbox.profiles.rejected";

const MIGRATION_INPUT_KEYS = [
  SETTINGS_VERSION_STORAGE_KEY,
  LEGACY_OPTIONS_STORAGE_KEY,
  PROFILES_STORAGE_KEY,
  PERFORMANCE_BUDGET_STORAGE_KEY
];

/** What the migration writes (one atomic `set`) and then removes. */
export type SettingsMigrationPlan = {
  set: Record<string, unknown>;
  remove: string[];
};

export type SettingsMigrationResult =
  { status: "current" | "migrated" } | { status: "failed"; error: string };

type SettingsStorageArea = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove?(keys: string | string[]): Promise<void>;
};

/**
 * The one-time settings moves, from the raw stored values; null when the settings are already
 * current. Idempotent: planning again on the result yields null.
 *
 * Version 1, v1 `webblackbox.options` into the profiles store:
 * - No valid profiles store: Default is built from v1 exactly as the old v1 read path built it.
 *   A store that failed validation is kept under `REJECTED_PROFILES_STORAGE_KEY`.
 * - A valid profiles store already drove recording (v1 only fed the performance budget): kept.
 * - The v1 performance budget moves to its own key unless that key is already set.
 *
 * Version 2, the built-in profiles become Maximum and Light (`migrateStoreToBuiltInPresets`):
 * references to removed presets and an untouched Default go to Maximum, a customised Default is
 * kept as a user profile. Rows of the stored store that failed validation are kept aside under
 * `REJECTED_PROFILES_STORAGE_KEY` before it is rewritten.
 */
export function planSettingsMigration(
  values: Record<string, unknown>
): SettingsMigrationPlan | null {
  const hasLegacyOptions = values[LEGACY_OPTIONS_STORAGE_KEY] !== undefined;
  const version = readSettingsVersion(values[SETTINGS_VERSION_STORAGE_KEY]);

  if (version >= SETTINGS_VERSION) {
    // Written after the migration by something outdated; nothing reads it any more.
    return hasLegacyOptions ? { set: {}, remove: [LEGACY_OPTIONS_STORAGE_KEY] } : null;
  }

  const legacy =
    version < LEGACY_OPTIONS_SETTINGS_VERSION ? asRecord(values[LEGACY_OPTIONS_STORAGE_KEY]) : null;
  const legacyProfiles = legacy ? planProfilesStore(legacy, values[PROFILES_STORAGE_KEY]) : {};
  const storeAfterLegacy = Object.hasOwn(legacyProfiles, PROFILES_STORAGE_KEY)
    ? legacyProfiles[PROFILES_STORAGE_KEY]
    : values[PROFILES_STORAGE_KEY];

  return {
    set: {
      ...legacyProfiles,
      ...planBuiltInPresets(storeAfterLegacy),
      ...(legacy ? planPerformanceBudget(legacy, values[PERFORMANCE_BUDGET_STORAGE_KEY]) : {}),
      [SETTINGS_VERSION_STORAGE_KEY]: SETTINGS_VERSION
    },
    remove: hasLegacyOptions ? [LEGACY_OPTIONS_STORAGE_KEY] : []
  };
}

/**
 * Runs the migration on `chrome.storage.local`. Never throws: a failed run leaves the version
 * unset, so the next start tries again.
 */
export async function migrateSettingsStorage(
  area: SettingsStorageArea | undefined
): Promise<SettingsMigrationResult> {
  if (!area) {
    return { status: "current" };
  }

  try {
    const plan = planSettingsMigration(await area.get(MIGRATION_INPUT_KEYS));

    if (!plan) {
      return { status: "current" };
    }

    if (Object.keys(plan.set).length > 0) {
      await area.set(plan.set);
    }

    if (plan.remove.length > 0) {
      await area.remove?.(plan.remove);
    }

    return { status: "migrated" };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

function planProfilesStore(
  legacy: Record<string, unknown>,
  rawStore: unknown
): Record<string, unknown> {
  if (parseProfilesStore(rawStore)) {
    return {};
  }

  return {
    [PROFILES_STORAGE_KEY]: serializeProfilesStore(migrateLegacyOptionsToProfiles(legacy)),
    ...keepRejectedProfilesStore(rawStore)
  };
}

/**
 * The profiles store moved to the built-in presets; nothing when there is no valid store (the
 * defaults already record with Maximum) or nothing changes.
 */
function planBuiltInPresets(rawStore: unknown): Record<string, unknown> {
  const parsed = parseProfilesStore(rawStore);

  if (!parsed) {
    return {};
  }

  const migrated = serializeProfilesStore(migrateStoreToBuiltInPresets(parsed.store));

  if (JSON.stringify(migrated) === JSON.stringify(serializeProfilesStore(parsed.store))) {
    return {};
  }

  return {
    [PROFILES_STORAGE_KEY]: migrated,
    // Rows the reader dropped would be lost with the rewrite: keep the stored store aside.
    ...(parsed.issues.length > 0 ? { [REJECTED_PROFILES_STORAGE_KEY]: rawStore } : {})
  };
}

/**
 * What to write next to a new profiles store so a stored one that failed validation is kept
 * aside under `REJECTED_PROFILES_STORAGE_KEY` instead of being lost; empty for a valid or no store.
 */
export function keepRejectedProfilesStore(rawStore: unknown): Record<string, unknown> {
  return rawStore !== undefined && rawStore !== null && !parseProfilesStore(rawStore)
    ? { [REJECTED_PROFILES_STORAGE_KEY]: rawStore }
    : {};
}

function planPerformanceBudget(
  legacy: Record<string, unknown>,
  rawBudget: unknown
): Record<string, unknown> {
  // Without a stored budget the defaults apply, as they did when v1 had none.
  if (rawBudget !== undefined || !asRecord(legacy.performanceBudget)) {
    return {};
  }

  return { [PERFORMANCE_BUDGET_STORAGE_KEY]: normalizePerformanceBudget(legacy.performanceBudget) };
}

function readSettingsVersion(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
