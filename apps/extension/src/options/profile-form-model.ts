import {
  REDACTION_TARGETS,
  type CaptureMode,
  type RedactionTarget,
  type RedactionValuePattern
} from "@webblackbox/protocol";

import {
  CAPTURE_CATEGORY_KEYS,
  CAPTURE_CATEGORY_LEVELS,
  type CaptureCategories
} from "../shared/profiles/categories.js";
import {
  isDefaultLocalDataSettings,
  resolveLocalDataSettings
} from "../shared/profiles/local-data.js";
import {
  DEFAULT_PROFILE_ID,
  MAX_BODY_CAPTURE_BYTES,
  MAX_MOUSEMOVE_HZ,
  MAX_RULE_PRIORITY,
  MAX_UNEXPORTED_RETENTION_MINUTES,
  MIN_RULE_PRIORITY,
  MIN_UNEXPORTED_RETENTION_MINUTES,
  type ProfileLocalDataSettings,
  type ProfileRule,
  type ProfileVisualCapture,
  type RecordingProfile,
  type RecordingProfilesStore
} from "../shared/profiles/model.js";
import { duplicateProfile } from "../shared/profiles/presets.js";

/** Raw string values of the profile form, as read from the DOM. */
export type ProfileFormValues = {
  name: string;
  base: string;
  categories: Partial<Record<keyof CaptureCategories, string>>;
  /** "Mask captured content": the master switch of every redaction rule below. */
  contentRedaction: boolean;
  /** The built-in heuristic rule set (best effort). */
  builtInHeuristics: boolean;
  blockedSelectors: string;
  unmaskSelectors: string;
  redactHeaders: string;
  redactCookieNames: string;
  redactBodyPatterns: string;
  redactQueryParams: string;
  redactStorageKeys: string;
  /** One rule per line: `[bodies, console] regex`, or just `regex` for every target. */
  valuePatterns: string;
  bodyMimeAllowlist: string;
  bodyMaxBytes: string;
  includeUrls: string;
  excludeUrls: string;
  mousemoveHz: string;
  visual: string;
  deleteAfterExport: boolean;
  unexportedRetentionMinutes: string;
};

/** Raw string values of one rule row. */
export type RuleFormValues = {
  id: string;
  name: string;
  profileId: string;
  priority: string;
  enabled: boolean;
  hosts: string;
  paths: string;
  query: string;
  titleRegex: string;
  selectorPresent: string;
  metaName: string;
  metaValue: string;
  incognito: string;
};

const VISUAL_VALUES: readonly ProfileVisualCapture[] = ["none", "screenshots", "recording", "both"];
const VALUE_PATTERN_LINE = /^\[([^\]]*)\]\s*(.*)$/;

/**
 * Value pattern lines as rules. Targets and patterns are not checked here: the profile schema
 * rejects unknown targets and unsupported patterns when the profile is saved.
 */
export function parseValuePatternLines(value: string): RedactionValuePattern[] {
  return splitLines(value).map((line) => {
    const match = VALUE_PATTERN_LINE.exec(line);

    if (!match) {
      return { pattern: line, targets: [...REDACTION_TARGETS] };
    }

    const targets = (match[1] ?? "")
      .split(",")
      .map((target) => target.trim().toLowerCase())
      .filter((target) => target.length > 0) as RedactionTarget[];

    return { pattern: (match[2] ?? "").trim(), targets };
  });
}

export function formatValuePatternLines(rules: readonly RedactionValuePattern[] = []): string {
  return rules
    .map((rule) =>
      // A pattern starting with `[` keeps an explicit prefix, or it would read back as targets.
      !rule.pattern.startsWith("[") &&
      rule.targets.length === REDACTION_TARGETS.length &&
      REDACTION_TARGETS.every((target) => rule.targets.includes(target))
        ? rule.pattern
        : `[${rule.targets.join(", ")}] ${rule.pattern}`
    )
    .join("\n");
}

export function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line, index, lines) => line.length > 0 && lines.indexOf(line) === index);
}

export function joinLines(values: readonly string[]): string {
  return values.join("\n");
}

/** Empty input = undefined ("inherit"); otherwise a clamped integer. */
export function parseOptionalInt(value: string, min: number, max: number): number | undefined {
  const trimmed = value.trim();

  if (!trimmed) {
    return undefined;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : undefined;
}

/** `key=value` lines require an exact value; a bare `key` only requires presence. */
export function parseQueryLines(value: string): Record<string, string | true> | undefined {
  const entries = splitLines(value).map((line): [string, string | true] => {
    const separator = line.indexOf("=");
    return separator < 0
      ? [line, true]
      : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  });
  const valid = entries.filter(([key]) => key.length > 0);

  return valid.length > 0 ? Object.fromEntries(valid) : undefined;
}

export function formatQueryLines(query: Record<string, string | true> | undefined): string {
  return Object.entries(query ?? {})
    .map(([key, expected]) => (expected === true ? key : `${key}=${expected}`))
    .join("\n");
}

/** Applies the form to a profile; untouched settings (sampling, site policies …) are kept. */
export function applyProfileFormValues(
  profile: RecordingProfile,
  values: ProfileFormValues
): RecordingProfile {
  const categories = Object.fromEntries(
    CAPTURE_CATEGORY_KEYS.map((key) => {
      const candidate = values.categories[key];
      const levels = CAPTURE_CATEGORY_LEVELS[key] as readonly string[];
      return [key, candidate && levels.includes(candidate) ? candidate : profile.categories[key]];
    })
  ) as CaptureCategories;
  const bodyMaxBytes = parseOptionalInt(values.bodyMaxBytes, 0, MAX_BODY_CAPTURE_BYTES);
  const mousemoveHz = parseOptionalInt(values.mousemoveHz, 1, MAX_MOUSEMOVE_HZ);
  const visual = VISUAL_VALUES.find((entry) => entry === values.visual);
  const localData = localDataFromFormValues(profile, values);
  const withoutVisual = Object.fromEntries(
    Object.entries(profile).filter(([key]) => key !== "visual" && key !== "localData")
  ) as RecordingProfile;

  return {
    ...withoutVisual,
    name: values.name.trim() || profile.name,
    base: toCaptureMode(values.base, profile.base),
    categories,
    redaction: {
      ...profile.redaction,
      contentRedaction: values.contentRedaction,
      builtInHeuristics: values.builtInHeuristics,
      blockedSelectors: splitLines(values.blockedSelectors),
      redactHeaders: splitLines(values.redactHeaders).map((header) => header.toLowerCase()),
      redactCookieNames: splitLines(values.redactCookieNames),
      redactBodyPatterns: splitLines(values.redactBodyPatterns),
      redactQueryParams: splitLines(values.redactQueryParams),
      redactStorageKeys: splitLines(values.redactStorageKeys),
      valuePatterns: parseValuePatternLines(values.valuePatterns)
    },
    unmaskSelectors: splitLines(values.unmaskSelectors),
    network: {
      bodyMimeAllowlist: splitLines(values.bodyMimeAllowlist).map((mime) => mime.toLowerCase()),
      ...(bodyMaxBytes !== undefined ? { bodyMaxBytes } : {}),
      includeUrls: splitLines(values.includeUrls),
      excludeUrls: splitLines(values.excludeUrls)
    },
    pointer: {
      hover: profile.pointer.hover,
      drag: profile.pointer.drag,
      wheel: profile.pointer.wheel,
      ...(mousemoveHz !== undefined ? { mousemoveHz } : {})
    },
    ...(visual ? { visual } : {}),
    ...(localData ? { localData } : {})
  };
}

/**
 * The form always shows the effective local data settings. A profile that never set them keeps
 * the block absent (the defaults) until the form departs from the defaults.
 */
function localDataFromFormValues(
  profile: RecordingProfile,
  values: ProfileFormValues
): ProfileLocalDataSettings | undefined {
  const next: ProfileLocalDataSettings = {
    deleteAfterExport: values.deleteAfterExport,
    unexportedRetentionMinutes:
      parseOptionalInt(
        values.unexportedRetentionMinutes,
        MIN_UNEXPORTED_RETENTION_MINUTES,
        MAX_UNEXPORTED_RETENTION_MINUTES
      ) ?? resolveLocalDataSettings(profile).unexportedRetentionMinutes
  };

  return profile.localData || !isDefaultLocalDataSettings(next) ? next : undefined;
}

export function ruleFromFormValues(values: RuleFormValues): ProfileRule {
  const priority = parseOptionalInt(values.priority, MIN_RULE_PRIORITY, MAX_RULE_PRIORITY) ?? 0;
  const hosts = splitLines(values.hosts);
  const paths = splitLines(values.paths);
  const query = parseQueryLines(values.query);
  const titleRegex = values.titleRegex.trim();
  const selectorPresent = values.selectorPresent.trim();
  const metaName = values.metaName.trim();
  const metaValue = values.metaValue.trim();

  return {
    id: values.id,
    ...(values.name.trim() ? { name: values.name.trim() } : {}),
    profileId: values.profileId,
    priority,
    enabled: values.enabled,
    match: {
      ...(hosts.length > 0 ? { hosts } : {}),
      ...(paths.length > 0 ? { paths } : {}),
      ...(query ? { query } : {}),
      ...(titleRegex ? { titleRegex } : {}),
      ...(selectorPresent ? { selectorPresent } : {}),
      ...(metaName
        ? { metaTag: { name: metaName, ...(metaValue ? { value: metaValue } : {}) } }
        : {}),
      ...(values.incognito === "only"
        ? { incognito: true }
        : values.incognito === "never"
          ? { incognito: false }
          : {})
    }
  };
}

/** Unique id with a readable prefix, e.g. `profile-3`. */
export function createUniqueId(prefix: string, taken: readonly string[]): string {
  let index = taken.length + 1;

  while (taken.includes(`${prefix}-${index}`)) {
    index += 1;
  }

  return `${prefix}-${index}`;
}

export function duplicateIntoStore(
  store: RecordingProfilesStore,
  source: RecordingProfile
): { store: RecordingProfilesStore; id: string } {
  const id = createUniqueId(
    "profile",
    store.profiles.map((profile) => profile.id)
  );

  return {
    id,
    store: { ...store, profiles: [...store.profiles, duplicateProfile(source, { id })] }
  };
}

/** Removes a user profile, its rules, and resets the default when needed. */
export function deleteProfileFromStore(
  store: RecordingProfilesStore,
  profileId: string
): RecordingProfilesStore {
  if (profileId === DEFAULT_PROFILE_ID) {
    return store;
  }

  return {
    ...store,
    defaultProfileId:
      store.defaultProfileId === profileId ? DEFAULT_PROFILE_ID : store.defaultProfileId,
    profiles: store.profiles.filter((profile) => profile.id !== profileId),
    rules: store.rules.filter((rule) => rule.profileId !== profileId)
  };
}

function toCaptureMode(value: string, fallback: CaptureMode): CaptureMode {
  return value === "lite" || value === "full" ? value : fallback;
}
