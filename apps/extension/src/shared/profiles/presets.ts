import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_REDACTION_PROFILE,
  type RedactionProfile
} from "@webblackbox/protocol";

import type { CaptureCategories } from "./categories.js";
import {
  BUILT_IN_PROFILE_ID_PREFIX,
  DEFAULT_PROFILE_ID,
  MAX_PROFILE_NAME_LENGTH,
  type RecordingProfile
} from "./model.js";

export const BUILT_IN_PROFILE_IDS = {
  lite: `${BUILT_IN_PROFILE_ID_PREFIX}lite`,
  full: `${BUILT_IN_PROFILE_ID_PREFIX}full`,
  qa: `${BUILT_IN_PROFILE_ID_PREFIX}qa`,
  fullCapture: `${BUILT_IN_PROFILE_ID_PREFIX}full-capture`
} as const;

const QA_BODY_MAX_BYTES = 256 * 1024;
const FULL_CAPTURE_BODY_MAX_BYTES = 1024 * 1024;
const FULL_CAPTURE_MOUSEMOVE_HZ = 60;

const QA_BODY_MIME_ALLOWLIST = [
  "application/json",
  "application/*+json",
  "application/graphql",
  "application/graphql-response+json",
  "text/plain",
  "text/xml",
  "application/xml",
  "application/*+xml",
  "application/x-www-form-urlencoded"
];

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
  "application/x-www-form-urlencoded"
];

const DEFAULT_CATEGORIES: CaptureCategories = DEFAULT_CAPTURE_POLICY.categories;

/** Ceiling of what a non-extended profile may capture: today's Full mode, visuals included. */
export const STANDARD_CAPTURE_CEILING: CaptureCategories = {
  ...DEFAULT_CATEGORIES,
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
    export: {
      encryption: "optional",
      privacyScanner: "warn"
    },
    ...overrides
  };
}

/** The editable "Default" profile used when no v1 options exist. */
export function createDefaultProfile(): RecordingProfile {
  return createBaseProfile({
    id: DEFAULT_PROFILE_ID,
    name: "Default",
    description: "Today's behaviour; the Start button picks Lite or Full."
  });
}

const LITE_PRESET = createBaseProfile({
  id: BUILT_IN_PROFILE_IDS.lite,
  name: "Lite",
  description: "Page-side signals and network metadata. No bodies, console text or input values.",
  base: "lite"
});

const FULL_PRESET = createBaseProfile({
  id: BUILT_IN_PROFILE_IDS.full,
  name: "Full",
  description: "CDP network, navigation and screenshots. No bodies, console text or input values.",
  base: "full"
});

const QA_PRESET = createBaseProfile({
  id: BUILT_IN_PROFILE_IDS.qa,
  name: "QA",
  description:
    "Console text, JSON/text/form/XML/GraphQL bodies up to 256 KiB, raw DOM and screenshots.",
  base: "full",
  categories: {
    ...DEFAULT_CATEGORIES,
    actions: "allow",
    console: "allow",
    network: "body-allowlist",
    dom: "allow",
    screenshots: "allow",
    cdp: "safe-subset"
  },
  network: {
    bodyMimeAllowlist: QA_BODY_MIME_ALLOWLIST,
    bodyMaxBytes: QA_BODY_MAX_BYTES,
    includeUrls: [],
    excludeUrls: []
  },
  export: {
    encryption: "required",
    privacyScanner: "block"
  }
});

const FULL_CAPTURE_PRESET = createBaseProfile({
  id: BUILT_IN_PROFILE_IDS.fullCapture,
  name: "Full capture",
  description:
    "Everything: console with stacks, all textual bodies, input values (never passwords or blocked " +
    "selectors), storage values, raw DOM, screenshots, optional tab video, 60 Hz pointer.",
  base: "full",
  categories: {
    actions: "allow",
    inputs: "allow",
    dom: "allow",
    screenshots: "allow",
    screenRecordings: "allow",
    console: "allow",
    network: "body-allowlist",
    storage: "allow",
    indexedDb: "names-only",
    cookies: "names-only",
    cdp: "full",
    heapProfiles: "off"
  },
  network: {
    bodyMimeAllowlist: ALL_TEXT_BODY_MIME_ALLOWLIST,
    bodyMaxBytes: FULL_CAPTURE_BODY_MAX_BYTES,
    includeUrls: [],
    excludeUrls: []
  },
  pointer: {
    mousemoveHz: FULL_CAPTURE_MOUSEMOVE_HZ,
    hover: true,
    drag: true,
    wheel: true
  },
  export: {
    encryption: "required",
    privacyScanner: "block"
  }
});

/** Read-only presets, in display order. */
export const BUILT_IN_PROFILES: readonly RecordingProfile[] = [
  LITE_PRESET,
  FULL_PRESET,
  QA_PRESET,
  FULL_CAPTURE_PRESET
];

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
