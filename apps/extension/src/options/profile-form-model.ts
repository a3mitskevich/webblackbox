import type { CaptureMode } from "@webblackbox/protocol";

import {
  CAPTURE_CATEGORY_KEYS,
  CAPTURE_CATEGORY_LEVELS,
  type CaptureCategories
} from "../shared/profiles/categories.js";
import {
  DEFAULT_PROFILE_ID,
  MAX_BODY_CAPTURE_BYTES,
  MAX_MOUSEMOVE_HZ,
  MAX_RULE_PRIORITY,
  MIN_RULE_PRIORITY,
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
  blockedSelectors: string;
  unmaskSelectors: string;
  redactHeaders: string;
  redactBodyPatterns: string;
  bodyMimeAllowlist: string;
  bodyMaxBytes: string;
  includeUrls: string;
  excludeUrls: string;
  mousemoveHz: string;
  visual: string;
  requireEncryption: boolean;
  blockOnFindings: boolean;
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
  const withoutVisual = Object.fromEntries(
    Object.entries(profile).filter(([key]) => key !== "visual")
  ) as RecordingProfile;

  return {
    ...withoutVisual,
    name: values.name.trim() || profile.name,
    base: toCaptureMode(values.base, profile.base),
    categories,
    redaction: {
      ...profile.redaction,
      blockedSelectors: splitLines(values.blockedSelectors),
      redactHeaders: splitLines(values.redactHeaders).map((header) => header.toLowerCase()),
      redactBodyPatterns: splitLines(values.redactBodyPatterns)
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
    export: {
      encryption: values.requireEncryption ? "required" : "optional",
      privacyScanner: values.blockOnFindings ? "block" : "warn"
    }
  };
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

/** Highest priority first; ties keep list order (the order the engine evaluates them in). */
export function sortRulesForDisplay(rules: readonly ProfileRule[]): ProfileRule[] {
  return rules
    .map((rule, index) => ({ rule, index }))
    .sort((left, right) => right.rule.priority - left.rule.priority || left.index - right.index)
    .map((entry) => entry.rule);
}

/** Rules in the order of `ids` (the rows on screen); rules not listed follow in display order. */
function orderRulesByIds(rules: readonly ProfileRule[], ids: readonly string[]): ProfileRule[] {
  const position = new Map(ids.map((id, index) => [id, index]));
  const listed = rules
    .filter((rule) => position.has(rule.id))
    .sort((left, right) => (position.get(left.id) ?? 0) - (position.get(right.id) ?? 0));

  return [...listed, ...sortRulesForDisplay(rules.filter((rule) => !position.has(rule.id)))];
}

/**
 * Moves the rule at `from` to `to` in display order and renumbers priorities top to bottom, so
 * the order on screen is the order the rules win in. `shownIds` is the order the rows are shown
 * in; it wins over the priorities, which may hold an edit the list has not been re-sorted for.
 */
export function reorderRules(
  rules: readonly ProfileRule[],
  from: number,
  to: number,
  shownIds?: readonly string[]
): ProfileRule[] {
  const ordered = shownIds ? orderRulesByIds(rules, shownIds) : sortRulesForDisplay(rules);

  if (from < 0 || from >= ordered.length || to < 0 || to >= ordered.length || from === to) {
    return ordered;
  }

  const moved = ordered[from];
  const without = ordered.filter((_, index) => index !== from);
  const next = moved ? [...without.slice(0, to), moved, ...without.slice(to)] : without;
  const step = Math.max(1, Math.min(10, Math.floor(MAX_RULE_PRIORITY / next.length)));

  return next.map((rule, index) => ({ ...rule, priority: (next.length - index) * step }));
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

/** JSON with object keys sorted, so equal drafts compare equal as strings. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([left], [right]) =>
            left.localeCompare(right)
          )
        )
      : entry
  );
}
