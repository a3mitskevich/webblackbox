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
  completeCaptureCategories,
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
import { STANDARD_CAPTURE_CEILING } from "./presets.js";
import { findMatchingRule, type ProfilePageContext } from "./rules.js";
import type { ProfilesState } from "./storage.js";

/** `requestedProfileId` value meaning "let the site rules decide". */
export const AUTO_PROFILE_ID = "auto";

export type ProfileSelectionSource = "explicit" | "rule" | "default";

export type ProfileSelection = {
  /** Effective profile: exactly the one chosen, on any host. */
  profile: RecordingProfile;
  source: ProfileSelectionSource;
  rule?: { id: string; name?: string };
  /** Effective profile captures more than the standard Full ceiling (informational). */
  extended: boolean;
};

/** What lands in `meta.config.profile` and therefore in the archive. */
export type ArchivedProfileInfo = {
  id: string;
  name: string;
  source: ProfileSelectionSource;
  ruleId?: string;
  ruleName?: string;
  extended: boolean;
  /** Categories the enterprise `dataCategoryCaps` lowered below what the profile asks for. */
  enterpriseCapped?: CaptureCategoryKey[];
};

/**
 * Picks the profile for a page: an explicit choice wins, then the best matching site rule, then
 * the store default, then the first profile left. The chosen profile runs as it is on every host;
 * enterprise data category caps are applied later, on the recorder config. Returns null when no
 * profile exists at all: recording needs one.
 */
export function selectRecordingProfile(input: {
  state: ProfilesState;
  page: ProfilePageContext;
  requestedProfileId?: string;
}): ProfileSelection | null {
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
  const profile =
    explicit ??
    ruleProfile ??
    byId(state.store.defaultProfileId) ??
    byId(DEFAULT_PROFILE_ID) ??
    state.catalog[0];

  if (!profile) {
    return null;
  }

  const source: ProfileSelectionSource = explicit ? "explicit" : ruleProfile ? "rule" : "default";
  const ruleInfo =
    ruleProfile && rule ? { id: rule.id, ...(rule.name ? { name: rule.name } : {}) } : undefined;

  return {
    profile,
    source,
    ...(ruleInfo ? { rule: ruleInfo } : {}),
    extended: isExtendedCaptureProfile(profile)
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
 * Categories the enterprise caps lowered: what the profile's config asks for vs what runs. Shown
 * in the popup and recorded in the archive so a capped recording never looks complete.
 */
export function listEnterpriseCappedCategories(
  requested: RecorderConfig,
  effective: RecorderConfig
): CaptureCategoryKey[] {
  const wanted = requested.capturePolicy?.categories;
  const running = effective.capturePolicy?.categories;
  return wanted && running
    ? findCategoriesAboveCeiling(
        completeCaptureCategories(wanted),
        completeCaptureCategories(running)
      )
    : [];
}

/**
 * Turns a profile into the recorder config for a transport. The profile is rendered as a v1
 * options record and run through the same merge + mode boundary as before profiles, so a Default
 * profile migrated from v1 options reproduces the config those options gave exactly.
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

  return {
    ...applyFullModeVisualCapture(config, mode, profile.visual ?? input.visualCapture),
    pointer: {
      hover: profile.pointer.hover,
      drag: profile.pointer.drag,
      wheel: profile.pointer.wheel
    }
  };
}

/** v1-shaped options record equivalent to a profile (only the keys the merge reads). */
export function toLegacyOptionsRecord(profile: RecordingProfile): Record<string, unknown> {
  // `profile.unmaskSelectors` is the only unmask source: `isExtendedCaptureProfile` reads it.
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

export function toArchivedProfileInfo(
  selection: ProfileSelection,
  enterpriseCapped: readonly CaptureCategoryKey[] = []
): ArchivedProfileInfo {
  return {
    id: selection.profile.id,
    name: selection.profile.name,
    source: selection.source,
    ...(selection.rule ? { ruleId: selection.rule.id } : {}),
    ...(selection.rule?.name ? { ruleName: selection.rule.name } : {}),
    extended: selection.extended,
    ...(enterpriseCapped.length > 0 ? { enterpriseCapped: [...enterpriseCapped] } : {})
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
