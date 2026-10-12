import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_REDACTION_PROFILE,
  type RedactionProfile
} from "@webblackbox/protocol";

import { FULL_MODE_BODY_CAPTURE_MAX_BYTES } from "../body-capture-limits.js";
import { completeCaptureCategories, type CaptureCategories } from "./categories.js";
import {
  BUILT_IN_PROFILE_ID_PREFIX,
  DEFAULT_PROFILE_ID,
  MAX_PROFILE_NAME_LENGTH,
  type RecordingProfile
} from "./model.js";

export const BUILT_IN_PROFILE_IDS = {
  maximum: `${BUILT_IN_PROFILE_ID_PREFIX}maximum`,
  lite: `${BUILT_IN_PROFILE_ID_PREFIX}lite`
} as const;

/** The profile a fresh install records with, and where references to removed presets go. */
export const DEFAULT_BUILT_IN_PROFILE_ID: string = BUILT_IN_PROFILE_IDS.maximum;

/**
 * Presets of earlier versions (Full, QA and Full capture, which became Maximum). The settings
 * migration and the managed policy map references to them to Maximum.
 */
export const REMOVED_BUILT_IN_PROFILE_IDS: readonly string[] = [
  `${BUILT_IN_PROFILE_ID_PREFIX}full`,
  `${BUILT_IN_PROFILE_ID_PREFIX}qa`,
  `${BUILT_IN_PROFILE_ID_PREFIX}full-capture`
];

// The Full mode default: a profile that turns bodies on without a limit gets the same.
const MAXIMUM_BODY_MAX_BYTES = FULL_MODE_BODY_CAPTURE_MAX_BYTES;
const MAXIMUM_MOUSEMOVE_HZ = 60;

const ALL_TEXT_BODY_MIME_ALLOWLIST = [
  "text/*",
  "application/json",
  "application/*+json",
  "application/x-ndjson",
  "application/graphql",
  "application/xml",
  "application/*+xml",
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "application/x-www-form-urlencoded",
  // SVG is text too; the Full engine keeps it by default (FULL_DEFAULT_BODY_MIME_ALLOWLIST).
  "image/svg+xml"
];

const DEFAULT_CATEGORIES: CaptureCategories = completeCaptureCategories(
  DEFAULT_CAPTURE_POLICY.categories
);

/**
 * Ceiling of what a non-extended profile may capture: today's Full mode, visuals and the page DOM
 * (masked by the profile's rules) included.
 */
export const STANDARD_CAPTURE_CEILING: CaptureCategories = {
  ...DEFAULT_CATEGORIES,
  dom: "allow",
  screenshots: "allow",
  screenRecordings: "allow",
  cdp: "safe-subset"
};

/**
 * Builds a profile with today's defaults. The Default/Lite/Full profiles leave every
 * "inherit" field (`pointer.mousemoveHz`, `network.bodyMaxBytes`, `visual`) unset so the
 * transport defaults and popup choices apply exactly as before profiles existed.
 */
export function createBaseProfile(
  overrides: Pick<RecordingProfile, "id" | "name"> & Partial<RecordingProfile>
): RecordingProfile {
  return {
    base: "lite",
    categories: { ...DEFAULT_CATEGORIES },
    redaction: cloneRedaction(DEFAULT_REDACTION_PROFILE),
    unmaskSelectors: [],
    network: {
      bodyMimeAllowlist: [],
      includeUrls: [],
      excludeUrls: []
    },
    pointer: {
      hover: false,
      drag: false,
      wheel: false
    },
    sampling: {},
    recorder: {},
    sitePolicies: [],
    ...overrides
  };
}

/**
 * The editable "Default" profile of earlier versions: Lite-mode defaults, the engine picked in
 * the popup. Fresh installs no longer get it; v1 options still migrate into it, and a customised
 * one is kept as a user profile.
 */
export function createDefaultProfile(): RecordingProfile {
  return createBaseProfile({
    id: DEFAULT_PROFILE_ID,
    name: "Default",
    description: "Today's behaviour; the Start button picks Lite or Full."
  });
}

const LIGHT_PRESET = createBaseProfile({
  id: BUILT_IN_PROFILE_IDS.lite,
  name: "Light",
  description:
    "Page-side signals and network metadata, no debugger. No bodies, console text or input values.",
  base: "lite"
});

const MAXIMUM_PRESET = createBaseProfile({
  id: BUILT_IN_PROFILE_IDS.maximum,
  name: "Maximum",
  description:
    "Everything, recorded raw (no content masking): console with stacks, all textual bodies, " +
    "input values and keys (passwords included), storage values, the raw DOM, screenshots and " +
    "tab video, 60 Hz pointer, other tabs of the site. The archive is always encrypted.",
  base: "full",
  categories: {
    actions: "allow",
    inputs: "allow",
    // The page itself as captured (owner decision, backlog item 10); the archive is encrypted.
    dom: "allow",
    screenshots: "allow",
    screenRecordings: "allow",
    console: "allow",
    network: "body-allowlist",
    storage: "allow",
    // Values (bounded): cookie values, HttpOnly ones included, and IndexedDB records.
    indexedDb: "allow",
    cookies: "allow",
    cdp: "full",
    heapProfiles: "off",
    tabsContext: "allow"
  },
  network: {
    bodyMimeAllowlist: ALL_TEXT_BODY_MIME_ALLOWLIST,
    bodyMaxBytes: MAXIMUM_BODY_MAX_BYTES,
    includeUrls: [],
    excludeUrls: []
  },
  // Content is recorded as captured: no masking, hashing or URL stripping. The categories above
  // still decide what is captured, and the archive is always encrypted.
  redaction: {
    ...cloneRedaction(DEFAULT_REDACTION_PROFILE),
    contentRedaction: false,
    blockedSelectors: []
  },
  pointer: {
    mousemoveHz: MAXIMUM_MOUSEMOVE_HZ,
    hover: true,
    drag: true,
    wheel: true
  },
  // Screenshots and the tab video, without a choice in the popup (owner decision, task 61).
  visual: "both",
  sourceMaps: { mode: "embed" }
  // No `localData`: an unexported recording is kept until it is exported or deleted.
});

/** Read-only presets, in display order. */
export const BUILT_IN_PROFILES: readonly RecordingProfile[] = [MAXIMUM_PRESET, LIGHT_PRESET];

/**
 * Profiles "Restore recommended profiles" brings back: the built-in presets. Each of them can be
 * deleted.
 */
export const RECOMMENDED_PROFILE_IDS: readonly string[] = BUILT_IN_PROFILES.map(
  (profile) => profile.id
);

export function isRecommendedProfileId(id: string): boolean {
  return RECOMMENDED_PROFILE_IDS.includes(id);
}

export function findBuiltInProfile(id: string): RecordingProfile | undefined {
  return BUILT_IN_PROFILES.find((profile) => profile.id === id);
}

/** Editable copy of any profile (built-in, managed or user) with a fresh id. */
export function duplicateProfile(
  profile: RecordingProfile,
  options: { id: string; name?: string }
): RecordingProfile {
  return {
    ...structuredClone(profile),
    id: options.id,
    name: (options.name ?? `${profile.name} (copy)`).slice(0, MAX_PROFILE_NAME_LENGTH)
  };
}

function cloneRedaction(profile: RedactionProfile): RedactionProfile {
  return {
    ...profile,
    redactHeaders: [...profile.redactHeaders],
    redactCookieNames: [...profile.redactCookieNames],
    redactBodyPatterns: [...profile.redactBodyPatterns],
    blockedSelectors: [...profile.blockedSelectors]
  };
}
