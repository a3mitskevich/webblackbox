import { z } from "zod";

import {
  PROFILES_SCHEMA_VERSION,
  recordingProfilesStoreSchema,
  type ProfileRule,
  type RecordingProfile,
  type RecordingProfilesStore
} from "./model.js";
import { describeIssues, parseProfilesStore } from "./storage.js";

export const PROFILES_EXPORT_FORMAT = "webblackbox-recording-profiles";
/** Imports larger than this are rejected before parsing. */
export const MAX_PROFILES_IMPORT_BYTES = 1024 * 1024;

/** JSON file handed to testers so everyone records with the same profiles and rules. */
export type ProfilesExportFile = RecordingProfilesStore & {
  format: typeof PROFILES_EXPORT_FORMAT;
  exportedAt: string;
};

export type EntityChange = { id: string; name: string; fields: string[] };

export type EntityDiff = {
  added: Array<{ id: string; name: string }>;
  removed: Array<{ id: string; name: string }>;
  changed: EntityChange[];
  unchanged: number;
};

export type ProfilesDiff = {
  profiles: EntityDiff;
  rules: EntityDiff;
  defaultProfileId?: { from: string; to: string };
  extendedCaptureHosts: { added: string[]; removed: string[] };
  /** Deleted recommended profiles before and after the import, when they differ. */
  removedRecommendedProfileIds?: { from: string[]; to: string[] };
  hasChanges: boolean;
};

export type ProfilesImportPreview =
  | { ok: true; next: RecordingProfilesStore; diff: ProfilesDiff }
  | { ok: false; error: string };

const exportEnvelopeSchema = recordingProfilesStoreSchema.extend({
  format: z.literal(PROFILES_EXPORT_FORMAT),
  exportedAt: z.string().max(64).optional()
});

export function createProfilesExportFile(
  store: RecordingProfilesStore,
  now: Date = new Date()
): ProfilesExportFile {
  return {
    format: PROFILES_EXPORT_FORMAT,
    exportedAt: now.toISOString(),
    schemaVersion: PROFILES_SCHEMA_VERSION,
    defaultProfileId: store.defaultProfileId,
    profiles: structuredClone(store.profiles),
    rules: structuredClone(store.rules),
    extendedCaptureHosts: [...store.extendedCaptureHosts],
    ...(store.removedRecommendedProfileIds?.length
      ? { removedRecommendedProfileIds: [...store.removedRecommendedProfileIds] }
      : {})
  };
}

/**
 * Validates an exported profiles file and diffs it against the current store. Nothing is applied:
 * the caller shows the diff and saves `next` only after the user confirms. Any invalid row rejects
 * the whole import so testers never end up with a half-applied setup.
 */
export function previewProfilesImport(
  text: string,
  current: RecordingProfilesStore
): ProfilesImportPreview {
  if (new TextEncoder().encode(text).byteLength > MAX_PROFILES_IMPORT_BYTES) {
    return { ok: false, error: "File is too large for a profiles export." };
  }

  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "File is not valid JSON." };
  }

  const envelope = exportEnvelopeSchema.safeParse(raw);

  if (!envelope.success) {
    return { ok: false, error: "File is not a WebBlackbox recording profiles export." };
  }

  const parsed = parseProfilesStore({
    schemaVersion: envelope.data.schemaVersion,
    defaultProfileId: envelope.data.defaultProfileId,
    profiles: envelope.data.profiles,
    rules: envelope.data.rules,
    extendedCaptureHosts: envelope.data.extendedCaptureHosts,
    removedRecommendedProfileIds: envelope.data.removedRecommendedProfileIds
  });

  if (!parsed) {
    return { ok: false, error: "File is not a WebBlackbox recording profiles export." };
  }

  // Rules and a default that point to a missing profile are kept, as deleting a profile keeps
  // them: the rule engine skips such rules, the default falls back, and Options flags both.
  if (parsed.issues.length > 0) {
    return { ok: false, error: describeIssues(parsed.issues) };
  }

  return { ok: true, next: parsed.store, diff: diffProfilesStores(current, parsed.store) };
}

export function diffProfilesStores(
  current: RecordingProfilesStore,
  next: RecordingProfilesStore
): ProfilesDiff {
  const profiles = diffEntities(current.profiles, next.profiles, (profile) => profile.name);
  const rules = diffEntities(current.rules, next.rules, (rule) => rule.name ?? rule.id);
  const extendedCaptureHosts = {
    added: next.extendedCaptureHosts.filter((host) => !current.extendedCaptureHosts.includes(host)),
    removed: current.extendedCaptureHosts.filter(
      (host) => !next.extendedCaptureHosts.includes(host)
    )
  };
  const defaultProfileId =
    current.defaultProfileId !== next.defaultProfileId
      ? { from: current.defaultProfileId, to: next.defaultProfileId }
      : undefined;
  const removedFrom = current.removedRecommendedProfileIds ?? [];
  const removedTo = next.removedRecommendedProfileIds ?? [];
  const removedRecommendedProfileIds =
    JSON.stringify(removedFrom) !== JSON.stringify(removedTo)
      ? { from: [...removedFrom], to: [...removedTo] }
      : undefined;

  return {
    profiles,
    rules,
    ...(defaultProfileId ? { defaultProfileId } : {}),
    extendedCaptureHosts,
    ...(removedRecommendedProfileIds ? { removedRecommendedProfileIds } : {}),
    hasChanges:
      hasEntityChanges(profiles) ||
      hasEntityChanges(rules) ||
      defaultProfileId !== undefined ||
      removedRecommendedProfileIds !== undefined ||
      extendedCaptureHosts.added.length > 0 ||
      extendedCaptureHosts.removed.length > 0
  };
}

function diffEntities<TEntity extends RecordingProfile | ProfileRule>(
  current: readonly TEntity[],
  next: readonly TEntity[],
  label: (entity: TEntity) => string
): EntityDiff {
  const currentById = new Map(current.map((entity) => [entity.id, entity]));
  const nextIds = new Set(next.map((entity) => entity.id));
  const diff: EntityDiff = { added: [], removed: [], changed: [], unchanged: 0 };

  for (const entity of next) {
    const previous = currentById.get(entity.id);

    if (!previous) {
      diff.added.push({ id: entity.id, name: label(entity) });
      continue;
    }

    const fields = changedFields(previous, entity);

    if (fields.length > 0) {
      diff.changed.push({ id: entity.id, name: label(entity), fields });
    } else {
      diff.unchanged += 1;
    }
  }

  for (const entity of current) {
    if (!nextIds.has(entity.id)) {
      diff.removed.push({ id: entity.id, name: label(entity) });
    }
  }

  return diff;
}

function changedFields(left: object, right: object): string[] {
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);

  return [...keys]
    .filter((key) => JSON.stringify(leftRecord[key]) !== JSON.stringify(rightRecord[key]))
    .sort();
}

function hasEntityChanges(diff: EntityDiff): boolean {
  return diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;
}
