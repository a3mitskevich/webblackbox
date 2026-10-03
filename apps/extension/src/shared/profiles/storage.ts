import {
  capturePolicySchema,
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_REDACTION_PROFILE,
  redactionProfileSchema,
  siteCapturePolicySchema,
  type SiteCapturePolicy
} from "@webblackbox/protocol";

import { migrateStoredRecorderConfig } from "../options-storage.js";
import {
  DEFAULT_PROFILE_ID,
  isReadOnlyProfileId,
  MANAGED_PROFILE_ID_PREFIX,
  MAX_PROFILES,
  MAX_RULES,
  PROFILES_SCHEMA_VERSION,
  profileRuleSchema,
  recordingProfileSchema,
  recordingProfilesStoreSchema,
  type ProfileRule,
  type RecordingProfile,
  type RecordingProfilesStore
} from "./model.js";
import { BUILT_IN_PROFILES, createDefaultProfile } from "./presets.js";

/** Why the effective store looks the way it does; surfaced in the options page. */
export type ProfilesStoreIssue =
  | { kind: "corrupt-store"; message: string }
  | { kind: "invalid-profile"; index: number; message: string }
  | { kind: "invalid-rule"; index: number; message: string }
  | { kind: "reserved-profile-id"; id: string }
  | { kind: "duplicate-id"; id: string }
  | { kind: "missing-default-profile"; id: string };

export type ParsedProfilesStore = {
  store: RecordingProfilesStore;
  issues: ProfilesStoreIssue[];
};

/** Everything the service worker and UI need to pick a profile. */
export type ProfilesState = {
  store: RecordingProfilesStore;
  /** No v2 store yet: Default is derived from v1 options on every read (today's behaviour). */
  legacy: boolean;
  /** Built-ins, enterprise-managed and user profiles, in display order. */
  catalog: RecordingProfile[];
  /** Managed rules first, then user rules. */
  rules: ProfileRule[];
  issues: ProfilesStoreIssue[];
};

export type ManagedProfilesPolicy = {
  profiles: RecordingProfile[];
  rules: ProfileRule[];
  issues: ProfilesStoreIssue[];
};

export const EMPTY_MANAGED_PROFILES: ManagedProfilesPolicy = {
  profiles: [],
  rules: [],
  issues: []
};

/**
 * Turns the v1 `webblackbox.options` record into the v2 store with a single "Default" profile.
 * The profile keeps every v1 knob that changed recording (sampling, redaction, ring buffer,
 * freeze-on-error, site body policies, capture policy) so recording stays identical.
 */
export function migrateLegacyOptionsToProfiles(legacyOptions: unknown): RecordingProfilesStore {
  return {
    schemaVersion: PROFILES_SCHEMA_VERSION,
    defaultProfileId: DEFAULT_PROFILE_ID,
    profiles: [migrateLegacyDefaultProfile(legacyOptions)],
    rules: [],
    extendedCaptureHosts: []
  };
}

/** Validates a stored v2 store. Bad rows are dropped one by one; a bad envelope yields null. */
export function parseProfilesStore(raw: unknown): ParsedProfilesStore | null {
  if (raw === undefined || raw === null) {
    return null;
  }

  const envelope = recordingProfilesStoreSchema.safeParse(raw);

  if (!envelope.success) {
    return null;
  }

  const issues: ProfilesStoreIssue[] = [];
  const profiles = parseProfiles(envelope.data.profiles, issues, { allowReserved: false });
  const rules = parseRules(envelope.data.rules, issues);
  const defaultProfileId = envelope.data.defaultProfileId;

  return {
    store: {
      schemaVersion: PROFILES_SCHEMA_VERSION,
      defaultProfileId,
      profiles: ensureDefaultProfile(profiles),
      rules,
      extendedCaptureHosts: [...envelope.data.extendedCaptureHosts]
    },
    issues
  };
}

/**
 * Resolves the effective profiles state from raw storage values. Never throws: a corrupt v2
 * store falls back to the v1-derived Default profile and reports `corrupt-store`.
 */
export function resolveProfilesState(input: {
  rawProfilesStore: unknown;
  rawLegacyOptions: unknown;
  managed?: ManagedProfilesPolicy;
}): ProfilesState {
  const managed = input.managed ?? EMPTY_MANAGED_PROFILES;
  const parsed = parseProfilesStore(input.rawProfilesStore);
  const issues: ProfilesStoreIssue[] = [...managed.issues];
  const legacy = parsed === null;

  if (parsed === null && input.rawProfilesStore !== undefined && input.rawProfilesStore !== null) {
    issues.push({ kind: "corrupt-store", message: "Stored profiles failed validation." });
  }

  const store = parsed?.store ?? migrateLegacyOptionsToProfiles(input.rawLegacyOptions);
  issues.push(...(parsed?.issues ?? []));

  const catalog = [...store.profiles, ...managed.profiles, ...BUILT_IN_PROFILES];
  const catalogIds = new Set(catalog.map((profile) => profile.id));

  if (!catalogIds.has(store.defaultProfileId)) {
    issues.push({ kind: "missing-default-profile", id: store.defaultProfileId });
  }

  return {
    store: catalogIds.has(store.defaultProfileId)
      ? store
      : { ...store, defaultProfileId: DEFAULT_PROFILE_ID },
    legacy,
    catalog,
    rules: [...managed.rules, ...store.rules],
    issues
  };
}

/** Parses enterprise-managed `profiles` / `rules`; managed ids are namespaced `managed:`. */
export function parseManagedProfilesPolicy(value: unknown): ManagedProfilesPolicy {
  const record = asRecord(value);

  if (!record) {
    return EMPTY_MANAGED_PROFILES;
  }

  const issues: ProfilesStoreIssue[] = [];
  const profiles = parseProfiles(
    Array.isArray(record.profiles) ? record.profiles.slice(0, MAX_PROFILES) : [],
    issues,
    { allowReserved: true }
  ).map((profile) => ({ ...profile, id: toManagedId(profile.id) }));
  const rules = parseRules(
    Array.isArray(record.rules) ? record.rules.slice(0, MAX_RULES) : [],
    issues
  ).map((rule) => ({
    ...rule,
    id: toManagedId(rule.id),
    profileId: isReadOnlyProfileId(rule.profileId) ? rule.profileId : toManagedId(rule.profileId)
  }));

  return { profiles, rules, issues };
}

/** Serializes the store for `chrome.storage.local` after a final validation pass. */
export function serializeProfilesStore(store: RecordingProfilesStore): RecordingProfilesStore {
  const issues: ProfilesStoreIssue[] = [];
  const profiles = parseProfiles(store.profiles, issues, { allowReserved: false });
  const rules = parseRules(store.rules, issues);

  if (issues.length > 0) {
    throw new Error(`Profiles are invalid: ${describeIssues(issues)}`);
  }

  return {
    schemaVersion: PROFILES_SCHEMA_VERSION,
    defaultProfileId: store.defaultProfileId,
    profiles: ensureDefaultProfile(profiles),
    rules,
    extendedCaptureHosts: [...store.extendedCaptureHosts]
  };
}

export function describeIssues(issues: readonly ProfilesStoreIssue[]): string {
  return issues
    .map((issue) => {
      switch (issue.kind) {
        case "invalid-profile":
          return `profile #${issue.index + 1}: ${issue.message}`;
        case "invalid-rule":
          return `rule #${issue.index + 1}: ${issue.message}`;
        case "reserved-profile-id":
          return `profile id "${issue.id}" is reserved`;
        case "duplicate-id":
          return `duplicate id "${issue.id}"`;
        case "missing-default-profile":
          return `default profile "${issue.id}" does not exist`;
        case "corrupt-store":
          return issue.message;
      }
    })
    .join("; ");
}

function parseProfiles(
  entries: readonly unknown[],
  issues: ProfilesStoreIssue[],
  options: { allowReserved: boolean }
): RecordingProfile[] {
  const output: RecordingProfile[] = [];
  const seen = new Set<string>();

  entries.forEach((entry, index) => {
    const parsed = recordingProfileSchema.safeParse(entry);

    if (!parsed.success) {
      issues.push({ kind: "invalid-profile", index, message: summarizeZodError(parsed.error) });
      return;
    }

    const profile = parsed.data as RecordingProfile;

    if (!options.allowReserved && isReadOnlyProfileId(profile.id)) {
      issues.push({ kind: "reserved-profile-id", id: profile.id });
      return;
    }

    if (seen.has(profile.id)) {
      issues.push({ kind: "duplicate-id", id: profile.id });
      return;
    }

    seen.add(profile.id);
    output.push(profile);
  });

  return output;
}

function parseRules(entries: readonly unknown[], issues: ProfilesStoreIssue[]): ProfileRule[] {
  const output: ProfileRule[] = [];
  const seen = new Set<string>();

  entries.forEach((entry, index) => {
    const parsed = profileRuleSchema.safeParse(entry);

    if (!parsed.success) {
      issues.push({ kind: "invalid-rule", index, message: summarizeZodError(parsed.error) });
      return;
    }

    if (seen.has(parsed.data.id)) {
      issues.push({ kind: "duplicate-id", id: parsed.data.id });
      return;
    }

    seen.add(parsed.data.id);
    output.push(parsed.data as ProfileRule);
  });

  return output;
}

function ensureDefaultProfile(profiles: RecordingProfile[]): RecordingProfile[] {
  return profiles.some((profile) => profile.id === DEFAULT_PROFILE_ID)
    ? profiles
    : [createDefaultProfile(), ...profiles];
}

function migrateLegacyDefaultProfile(legacyOptions: unknown): RecordingProfile {
  const fallback = createDefaultProfile();
  const record = asRecord(legacyOptions);

  if (!record) {
    return fallback;
  }

  const migrated = migrateStoredRecorderConfig(record);
  const basePolicy = capturePolicySchema.safeParse(migrated.capturePolicy);
  const redaction = redactionProfileSchema.safeParse({
    ...DEFAULT_REDACTION_PROFILE,
    ...(asRecord(migrated.redaction) ?? {})
  });
  const candidate: RecordingProfile = {
    ...fallback,
    categories: basePolicy.success
      ? { ...basePolicy.data.categories }
      : { ...DEFAULT_CAPTURE_POLICY.categories },
    redaction: redaction.success ? redaction.data : fallback.redaction,
    unmaskSelectors: redaction.success ? [...(redaction.data.unmaskSelectors ?? [])] : [],
    sampling: pickValidSampling(migrated.sampling),
    recorder: {
      ...(isValidRingBufferMinutes(migrated.ringBufferMinutes)
        ? { ringBufferMinutes: migrated.ringBufferMinutes }
        : {}),
      ...(typeof migrated.freezeOnError === "boolean"
        ? { freezeOnError: migrated.freezeOnError }
        : {})
    },
    sitePolicies: pickValidSitePolicies(migrated.sitePolicies),
    ...(basePolicy.success ? { basePolicy: basePolicy.data } : {})
  };
  const validated = recordingProfileSchema.safeParse(candidate);

  return validated.success ? (validated.data as RecordingProfile) : fallback;
}

function pickValidSampling(value: unknown): RecordingProfile["sampling"] {
  const record = asRecord(value);

  if (!record) {
    return {};
  }

  const output: Record<string, number> = {};

  for (const [key, entry] of Object.entries(record)) {
    const candidate = recordingProfileSchema.shape.sampling.safeParse({ [key]: entry });

    if (candidate.success && typeof entry === "number") {
      output[key] = entry;
    }
  }

  return output as RecordingProfile["sampling"];
}

function pickValidSitePolicies(value: unknown): SiteCapturePolicy[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const parsed = siteCapturePolicySchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

function isValidRingBufferMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 120;
}

function toManagedId(id: string): string {
  return id.startsWith(MANAGED_PROFILE_ID_PREFIX) ? id : `${MANAGED_PROFILE_ID_PREFIX}${id}`;
}

function summarizeZodError(error: {
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>;
}): string {
  const first = error.issues[0];

  if (!first) {
    return "invalid";
  }

  const path = first.path.map(String).join(".");
  return path ? `${path}: ${first.message}` : first.message;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
