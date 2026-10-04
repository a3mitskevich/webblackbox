import {
  DEFAULT_CAPTURE_POLICY,
  usesBuiltInHeuristics,
  type CaptureMode,
  type RecorderConfig
} from "@webblackbox/protocol";

import type { FullModeVisualCapture } from "../messages.js";
import { applyFullModeVisualCapture, resolveModeBaseConfig } from "../mode-profile.js";
import { resolveModeRecorderConfig } from "../recorder-config.js";
import {
  clampCategoriesToCeiling,
  findCategoriesAboveCeiling,
  type CaptureCategoryKey
} from "./categories.js";
import {
  DEFAULT_PROFILE_ID,
  DEFAULT_SOURCE_MAP_MAX_BYTES,
  withoutRedactionUnmask,
  type ProfileSourceMapMode,
  type RecordingProfile
} from "./model.js";
import { BUILT_IN_PROFILE_IDS, findBuiltInProfile, STANDARD_CAPTURE_CEILING } from "./presets.js";
import { findMatchingRule, matchesHostPattern, type ProfilePageContext } from "./rules.js";
import type { ProfilesState } from "./storage.js";

/** `requestedProfileId` value meaning "let the site rules decide". */
export const AUTO_PROFILE_ID = "auto";

export type ProfileSelectionSource = "explicit" | "rule" | "default";

export type ProfileSelection = {
  /** Effective profile (after the extended-capture host gate). */
  profile: RecordingProfile;
  source: ProfileSelectionSource;
  rule?: { id: string; name?: string };
  /** Effective profile captures more than the standard Full ceiling. */
  extended: boolean;
  /** Set when an extended profile was replaced by Full on a host outside its allowlist. */
  downgradedFrom?: { id: string; name: string; reason: "host-not-allowed" };
  /** Effective profile is the v1-derived Default (no v2 store yet): no extra gates apply. */
  legacy: boolean;
};

/** What lands in `meta.config.profile` and therefore in the archive. */
export type ArchivedProfileInfo = {
  id: string;
  name: string;
  source: ProfileSelectionSource;
  ruleId?: string;
  ruleName?: string;
  extended: boolean;
  downgradedFrom?: { id: string; name: string; reason: string };
};

/**
 * Picks the profile for a page: an explicit choice wins, then the best matching site rule,
 * then the store default. Extended profiles only run on hosts their rules (or the allowlists)
 * cover; elsewhere they run as the built-in Full preset, keeping their own redaction and
 * retention settings and never more than Full captures.
 */
export function selectRecordingProfile(input: {
  state: ProfilesState;
  page: ProfilePageContext;
  requestedProfileId?: string;
  enterpriseSiteAllowlist?: readonly string[];
}): ProfileSelection {
  const { state } = input;
  const byId = (id: string | undefined): RecordingProfile | undefined =>
    id ? state.catalog.find((profile) => profile.id === id) : undefined;
  const explicit =
    input.requestedProfileId && input.requestedProfileId !== AUTO_PROFILE_ID
      ? byId(input.requestedProfileId)
      : undefined;
  const rule = explicit
    ? undefined
    : findMatchingRule(state.rules, input.page, (candidate) => !!byId(candidate.profileId));
  const ruleProfile = byId(rule?.profileId);
  const requested =
    explicit ?? ruleProfile ?? byId(state.store.defaultProfileId) ?? byId(DEFAULT_PROFILE_ID);
  const source: ProfileSelectionSource = explicit ? "explicit" : ruleProfile ? "rule" : "default";
  const profile = requested ?? fullPreset();
  const legacy = state.legacy && profile.id === DEFAULT_PROFILE_ID;
  const extended = !legacy && isExtendedCaptureProfile(profile);
  const ruleInfo =
    ruleProfile && rule ? { id: rule.id, ...(rule.name ? { name: rule.name } : {}) } : undefined;

  const selection: ProfileSelection = {
    profile,
    source,
    ...(ruleInfo ? { rule: ruleInfo } : {}),
    extended,
    legacy
  };

  if (
    extended &&
    !isHostAllowedForExtendedCapture({
      url: input.page.url,
      profileId: profile.id,
      state,
      enterpriseSiteAllowlist: input.enterpriseSiteAllowlist ?? []
    })
  ) {
    return downgradeExtendedSelection(selection);
  }

  return selection;
}

/** The same selection running as the Full preset because the host is not allowed. */
export function downgradeExtendedSelection(selection: ProfileSelection): ProfileSelection {
  if (!selection.extended) {
    return selection;
  }

  const { profile } = selection;

  return {
    profile: downgradeToFullPreset(profile),
    source: selection.source,
    ...(selection.rule ? { rule: { ...selection.rule } } : {}),
    extended: false,
    downgradedFrom: { id: profile.id, name: profile.name, reason: "host-not-allowed" },
    legacy: false
  };
}

/**
 * Categories above the standard Full ceiling, any unmask list, or content masking turned off
 * make a profile "extended".
 */
export function isExtendedCaptureProfile(profile: RecordingProfile): boolean {
  return (
    listExtendedCategories(profile).length > 0 ||
    profile.unmaskSelectors.length > 0 ||
    // Masking off, or only the user's own rules: content the defaults would strip is recorded.
    !usesBuiltInHeuristics(profile.redaction)
  );
}

export function listExtendedCategories(profile: RecordingProfile): CaptureCategoryKey[] {
  return findCategoriesAboveCeiling(profile.categories, STANDARD_CAPTURE_CEILING);
}

/**
 * Extended capture is allowed on hosts named by enabled rules that target the profile, by the
 * store's `extendedCaptureHosts`, or by the enterprise site allowlist.
 */
export function isHostAllowedForExtendedCapture(input: {
  url: string;
  profileId: string;
  state: ProfilesState;
  enterpriseSiteAllowlist: readonly string[];
}): boolean {
  let url: URL;

  try {
    url = new URL(input.url);
  } catch {
    return false;
  }

  const rulePatterns = input.state.rules
    .filter((rule) => rule.enabled && rule.profileId === input.profileId)
    .flatMap((rule) => rule.match.hosts ?? []);
  const patterns = [
    ...rulePatterns,
    ...input.state.store.extendedCaptureHosts,
    ...input.enterpriseSiteAllowlist
  ];

  return patterns.some((pattern) => matchesHostPattern(url, pattern));
}

/**
 * Turns a profile into the recorder config for a transport. The profile is rendered as a v1
 * options record and run through the same merge + mode boundary as before profiles, so the
 * migrated Default profile reproduces today's config exactly.
 */
export function buildProfileRecorderConfig(input: {
  mode: CaptureMode;
  profile: RecordingProfile;
  visualCapture?: FullModeVisualCapture;
}): RecorderConfig {
  const { mode, profile } = input;
  const config = resolveModeRecorderConfig(
    mode,
    resolveModeBaseConfig(mode),
    toLegacyOptionsRecord(profile)
  );

  return applyFullModeVisualCapture(config, mode, profile.visual ?? input.visualCapture);
}

/** v1-shaped options record equivalent to a profile (only the keys the merge reads). */
export function toLegacyOptionsRecord(profile: RecordingProfile): Record<string, unknown> {
  // `profile.unmaskSelectors` is the only unmask source: the extended-capture gate reads it.
  const redaction = {
    ...withoutRedactionUnmask(profile.redaction),
    ...(profile.unmaskSelectors.length > 0 ? { unmaskSelectors: [...profile.unmaskSelectors] } : {})
  };
  const sampling = {
    ...profile.sampling,
    ...(profile.pointer.mousemoveHz !== undefined
      ? { mousemoveHz: profile.pointer.mousemoveHz }
      : {}),
    ...(profile.network.bodyMaxBytes !== undefined
      ? { bodyCaptureMaxBytes: profile.network.bodyMaxBytes }
      : {})
  };

  return {
    optionsVersion: 1,
    ...profile.recorder,
    sampling,
    redaction,
    sitePolicies: profile.sitePolicies,
    capturePolicy: {
      ...(profile.basePolicy ?? DEFAULT_CAPTURE_POLICY),
      categories: { ...profile.categories },
      redaction
    }
  };
}

export function toArchivedProfileInfo(selection: ProfileSelection): ArchivedProfileInfo {
  return {
    id: selection.profile.id,
    name: selection.profile.name,
    source: selection.source,
    ...(selection.rule ? { ruleId: selection.rule.id } : {}),
    ...(selection.rule?.name ? { ruleName: selection.rule.name } : {}),
    extended: selection.extended,
    ...(selection.downgradedFrom ? { downgradedFrom: { ...selection.downgradedFrom } } : {})
  };
}

export type SourceMapCapture = {
  mode: ProfileSourceMapMode;
  maxMapBytes: number;
};

/**
 * Effective source map capture for a profile on a transport. Without an explicit setting, Full
 * mode records map references (the debugger reports them for free) and Lite records nothing.
 */
export function resolveSourceMapCapture(
  profile: Pick<RecordingProfile, "sourceMaps">,
  mode: CaptureMode
): SourceMapCapture {
  return {
    mode: profile.sourceMaps?.mode ?? (mode === "full" ? "metadata" : "off"),
    maxMapBytes: profile.sourceMaps?.maxMapBytes ?? DEFAULT_SOURCE_MAP_MAX_BYTES
  };
}

/** Same profile, rule and gate outcome: no need to reconfigure the recorder. */
export function isSameProfileSelection(left: ProfileSelection, right: ProfileSelection): boolean {
  return (
    left.profile.id === right.profile.id &&
    left.rule?.id === right.rule?.id &&
    left.downgradedFrom?.id === right.downgradedFrom?.id
  );
}

/**
 * The Full preset for an extended profile on a host outside its allowlist. Categories are the
 * lower of the two levels, so nothing the profile turned down is turned back on, and the
 * profile's redaction lists, sampling, retention, site policies and export rules are kept.
 * Body filters, pointer rate, visuals and unmask selectors come from Full.
 */
function downgradeToFullPreset(profile: RecordingProfile): RecordingProfile {
  const full = fullPreset();

  return {
    ...full,
    categories: clampCategoriesToCeiling(profile.categories, full.categories),
    // Masking off or without the built-in heuristics is extended capture: the Full preset's rules
    // apply instead (the profile's own lists may have been emptied).
    redaction: usesBuiltInHeuristics(profile.redaction)
      ? withoutRedactionUnmask(profile.redaction)
      : structuredClone(full.redaction),
    sampling: { ...profile.sampling },
    recorder: { ...profile.recorder },
    sitePolicies: profile.sitePolicies,
    ...(profile.basePolicy ? { basePolicy: profile.basePolicy } : {}),
    // Map references stay; storing maps (site source code) does not survive the downgrade.
    ...(profile.sourceMaps
      ? {
          sourceMaps: {
            ...profile.sourceMaps,
            mode: profile.sourceMaps.mode === "embed" ? "metadata" : profile.sourceMaps.mode
          }
        }
      : {}),
    export: { ...profile.export }
  };
}

function fullPreset(): RecordingProfile {
  const preset = findBuiltInProfile(BUILT_IN_PROFILE_IDS.full);

  if (!preset) {
    throw new Error("Built-in Full profile is missing.");
  }

  return preset;
}
