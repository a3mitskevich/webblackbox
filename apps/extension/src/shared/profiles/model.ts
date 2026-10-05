import {
  capturePolicySchema,
  captureModeSchema,
  redactionProfileSchema,
  siteCapturePolicySchema,
  type CaptureMode,
  type CapturePolicy,
  type RedactionProfile,
  type SamplingProfile,
  type SiteCapturePolicy
} from "@webblackbox/protocol";
import { z } from "zod";

import { CAPTURE_CATEGORY_LEVELS, type CaptureCategories } from "./categories.js";
import { compileTitleRegex } from "./title-regex.js";

/** `chrome.storage.local` key of the v2 profiles store. */
export const PROFILES_STORAGE_KEY = "webblackbox.profiles";
export const PROFILES_SCHEMA_VERSION = 2;
export const DEFAULT_PROFILE_ID = "default";
export const BUILT_IN_PROFILE_ID_PREFIX = "builtin:";
export const MANAGED_PROFILE_ID_PREFIX = "managed:";

export const MAX_PROFILES = 50;
export const MAX_PROFILE_NAME_LENGTH = 80;
export const MAX_RULES = 200;
export const MAX_LIST_ENTRIES = 200;
export const MAX_PATTERN_LENGTH = 500;
export const MAX_TITLE_REGEX_LENGTH = 300;
export const MIN_RULE_PRIORITY = -1000;
export const MAX_RULE_PRIORITY = 1000;
export const MAX_MOUSEMOVE_HZ = 240;
export const MAX_BODY_CAPTURE_BYTES = 8 * 1024 * 1024;
export const MIN_UNEXPORTED_RETENTION_MINUTES = 1;
export const MAX_UNEXPORTED_RETENTION_MINUTES = 24 * 60;
/** Default and hard cap for one source map embedded at record time. */
export const DEFAULT_SOURCE_MAP_MAX_BYTES = 8 * 1024 * 1024;
export const MAX_SOURCE_MAP_BYTES = 32 * 1024 * 1024;

/** Visual capture a profile pins; absent = the popup's choice (today's behaviour). */
export type ProfileVisualCapture = "none" | "screenshots" | "recording" | "both";

export type ProfileNetworkSettings = {
  /** MIME allowlist for captured bodies; empty = transport default list. */
  bodyMimeAllowlist: string[];
  /** Max captured body bytes; absent = transport default. */
  bodyMaxBytes?: number;
  /** URL globs a body must match to be captured; empty = all URLs. */
  includeUrls: string[];
  /** URL globs whose bodies are never captured. */
  excludeUrls: string[];
};

export type ProfilePointerSettings = {
  /** Pointer sampling rate; absent = transport default. */
  mousemoveHz?: number;
  hover: boolean;
  drag: boolean;
  wheel: boolean;
};

/**
 * Source map capture: `metadata` records each script's map reference, `embed` also stores the
 * map in the archive. A profile without `sourceMaps` uses metadata in Full mode (CDP) and
 * nothing in Lite mode, where capture refetches scripts.
 */
export type ProfileSourceMapMode = "off" | "metadata" | "embed";

export type ProfileSourceMapSettings = {
  mode: ProfileSourceMapMode;
  /** Largest map embedded; absent = `DEFAULT_SOURCE_MAP_MAX_BYTES`. */
  maxMapBytes?: number;
};

export type ProfileExportSettings = {
  encryption: "required" | "optional";
  privacyScanner: "block" | "warn";
};

/** What happens to the encrypted local copy of a recording on this device. */
export type ProfileLocalDataSettings = {
  /** Delete the local recording once its export has been handed to the browser's downloads. */
  deleteAfterExport: boolean;
  /** Minutes a stopped, unexported recording is kept before it is deleted. */
  unexportedRetentionMinutes: number;
};

export type RecordingProfile = {
  id: string;
  name: string;
  description?: string;
  /** Recommended transport: page-side (`lite`) or CDP-backed (`full`). */
  base: CaptureMode;
  categories: CaptureCategories;
  redaction: RedactionProfile;
  /** Selectors that stay readable even when blocked; password fields are never unmasked. */
  unmaskSelectors: string[];
  network: ProfileNetworkSettings;
  pointer: ProfilePointerSettings;
  visual?: ProfileVisualCapture;
  sourceMaps?: ProfileSourceMapSettings;
  sampling: Partial<SamplingProfile>;
  recorder: {
    ringBufferMinutes?: number;
    freezeOnError?: boolean;
  };
  /** Per-site body capture rules carried over from v1 options. */
  sitePolicies: SiteCapturePolicy[];
  /** Capture policy envelope migrated from v1 options (consent, context, retention); optional. */
  basePolicy?: CapturePolicy;
  export: ProfileExportSettings;
  /** Absent = the defaults (delete after export, today's 10-minute retention). */
  localData?: ProfileLocalDataSettings;
};

export type ProfileRuleMatch = {
  /** Host globs: `example.com`, `*.stage.example.com`, `localhost:*`, `127.0.0.1:3000`. */
  hosts?: string[];
  /** Path globs: `*` within a segment, `**` across segments. */
  paths?: string[];
  /** `true` = parameter present, string = exact value. */
  query?: Record<string, string | true>;
  titleRegex?: string;
  selectorPresent?: string;
  metaTag?: { name: string; value?: string };
  incognito?: boolean;
};

export type ProfileRule = {
  id: string;
  name?: string;
  profileId: string;
  priority: number;
  enabled: boolean;
  match: ProfileRuleMatch;
};

export type RecordingProfilesStore = {
  schemaVersion: typeof PROFILES_SCHEMA_VERSION;
  defaultProfileId: string;
  /** User profiles, including the editable "Default" one; built-in presets are never stored. */
  profiles: RecordingProfile[];
  rules: ProfileRule[];
  /**
   * Kept so older stores and exports still parse. Extended profiles are no longer limited to
   * hosts, so nothing reads it.
   */
  extendedCaptureHosts: string[];
  /**
   * Recommended profiles (Default and the built-in presets) the user deleted. Absent when none
   * was, so stores that never deleted one keep their exact shape.
   */
  removedRecommendedProfileIds?: string[];
};

const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,79}$/, "Invalid id: use letters, digits, : . _ -");
const patternSchema = z.string().trim().min(1).max(MAX_PATTERN_LENGTH);
const patternListSchema = z.array(patternSchema).max(MAX_LIST_ENTRIES);
const positiveIntSchema = z.number().int().positive();

const categoriesSchema = z
  .object({
    actions: z.enum(CAPTURE_CATEGORY_LEVELS.actions),
    inputs: z.enum(CAPTURE_CATEGORY_LEVELS.inputs),
    dom: z.enum(CAPTURE_CATEGORY_LEVELS.dom),
    screenshots: z.enum(CAPTURE_CATEGORY_LEVELS.screenshots),
    screenRecordings: z.enum(CAPTURE_CATEGORY_LEVELS.screenRecordings),
    console: z.enum(CAPTURE_CATEGORY_LEVELS.console),
    network: z.enum(CAPTURE_CATEGORY_LEVELS.network),
    storage: z.enum(CAPTURE_CATEGORY_LEVELS.storage),
    indexedDb: z.enum(CAPTURE_CATEGORY_LEVELS.indexedDb),
    cookies: z.enum(CAPTURE_CATEGORY_LEVELS.cookies),
    cdp: z.enum(CAPTURE_CATEGORY_LEVELS.cdp),
    heapProfiles: z.enum(CAPTURE_CATEGORY_LEVELS.heapProfiles)
  })
  .strict();

const samplingSchema = z
  .object({
    mousemoveHz: positiveIntSchema.max(MAX_MOUSEMOVE_HZ),
    scrollHz: positiveIntSchema.max(120),
    domFlushMs: positiveIntSchema.max(60_000),
    screenshotIdleMs: z.number().int().nonnegative().max(600_000),
    snapshotIntervalMs: positiveIntSchema.max(600_000),
    actionWindowMs: positiveIntSchema.max(60_000),
    bodyCaptureMaxBytes: z.number().int().nonnegative().max(MAX_BODY_CAPTURE_BYTES)
  })
  .partial()
  .strict();

export const recordingProfileSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1).max(MAX_PROFILE_NAME_LENGTH),
    description: z.string().max(500).optional(),
    base: captureModeSchema,
    categories: categoriesSchema,
    redaction: redactionProfileSchema.transform(withoutRedactionUnmask),
    unmaskSelectors: patternListSchema,
    network: z
      .object({
        bodyMimeAllowlist: patternListSchema,
        bodyMaxBytes: z.number().int().nonnegative().max(MAX_BODY_CAPTURE_BYTES).optional(),
        includeUrls: patternListSchema,
        excludeUrls: patternListSchema
      })
      .strict(),
    pointer: z
      .object({
        mousemoveHz: positiveIntSchema.max(MAX_MOUSEMOVE_HZ).optional(),
        hover: z.boolean(),
        drag: z.boolean(),
        wheel: z.boolean()
      })
      .strict(),
    visual: z.enum(["none", "screenshots", "recording", "both"]).optional(),
    sourceMaps: z
      .object({
        mode: z.enum(["off", "metadata", "embed"]),
        maxMapBytes: positiveIntSchema.max(MAX_SOURCE_MAP_BYTES).optional()
      })
      .strict()
      .optional(),
    sampling: samplingSchema,
    recorder: z
      .object({
        ringBufferMinutes: positiveIntSchema.max(120).optional(),
        freezeOnError: z.boolean().optional()
      })
      .strict(),
    sitePolicies: z.array(siteCapturePolicySchema).max(MAX_LIST_ENTRIES),
    basePolicy: capturePolicySchema.optional(),
    export: z
      .object({
        encryption: z.enum(["required", "optional"]),
        privacyScanner: z.enum(["block", "warn"])
      })
      .strict(),
    localData: z
      .object({
        deleteAfterExport: z.boolean(),
        unexportedRetentionMinutes: z
          .number()
          .int()
          .min(MIN_UNEXPORTED_RETENTION_MINUTES)
          .max(MAX_UNEXPORTED_RETENTION_MINUTES)
      })
      .strict()
      .optional()
  })
  .strict();

export const profileRuleSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().max(80).optional(),
    profileId: idSchema,
    priority: z.number().int().min(MIN_RULE_PRIORITY).max(MAX_RULE_PRIORITY),
    enabled: z.boolean(),
    match: z
      .object({
        hosts: patternListSchema.optional(),
        paths: patternListSchema.optional(),
        query: z
          .record(
            z.string().min(1).max(200),
            z.union([z.string().max(MAX_PATTERN_LENGTH), z.literal(true)])
          )
          .optional(),
        titleRegex: z
          .string()
          .min(1)
          .max(MAX_TITLE_REGEX_LENGTH)
          .refine(isCompilableRegex, "titleRegex must be a valid regular expression")
          .refine(
            (value) => compileTitleRegex(value) !== null,
            "titleRegex cannot use backreferences or lookarounds, or is too large"
          )
          .optional(),
        selectorPresent: patternSchema.optional(),
        metaTag: z
          .object({
            name: z.string().trim().min(1).max(200),
            value: z.string().max(MAX_PATTERN_LENGTH).optional()
          })
          .strict()
          .optional(),
        incognito: z.boolean().optional()
      })
      .strict()
  })
  .strict();

/** Envelope of the stored v2 store; entries are validated one by one so a bad row never wipes the rest. */
export const recordingProfilesStoreSchema = z
  .object({
    schemaVersion: z.literal(PROFILES_SCHEMA_VERSION),
    defaultProfileId: idSchema,
    profiles: z.array(z.unknown()).max(MAX_PROFILES),
    rules: z.array(z.unknown()).max(MAX_RULES),
    extendedCaptureHosts: patternListSchema,
    removedRecommendedProfileIds: z.array(idSchema).max(MAX_LIST_ENTRIES).optional()
  })
  .strict();

/**
 * Drops `unmaskSelectors` from a redaction profile. A profile keeps its unmask list only in
 * `RecordingProfile.unmaskSelectors`, which marks the profile as extended; a second copy
 * inside `redaction` would unmask fields without making the profile extended.
 */
export function withoutRedactionUnmask(redaction: RedactionProfile): RedactionProfile {
  return Object.fromEntries(
    Object.entries(redaction).filter(([key]) => key !== "unmaskSelectors")
  ) as RedactionProfile;
}

export function isBuiltInProfileId(id: string): boolean {
  return id.startsWith(BUILT_IN_PROFILE_ID_PREFIX);
}

export function isManagedProfileId(id: string): boolean {
  return id.startsWith(MANAGED_PROFILE_ID_PREFIX);
}

/**
 * Built-in and enterprise-managed profiles cannot be edited, only duplicated. Built-in presets can
 * be deleted (and restored); managed ones cannot.
 */
export function isReadOnlyProfileId(id: string): boolean {
  return isBuiltInProfileId(id) || isManagedProfileId(id);
}

function isCompilableRegex(value: string): boolean {
  try {
    new RegExp(value, "i");
    return true;
  } catch {
    return false;
  }
}
