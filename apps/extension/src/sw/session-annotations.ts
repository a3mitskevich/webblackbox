import type { SessionAnnotation, SessionRuntime } from "./session-registry.js";
import type { SnapshotStorageAreaLike } from "./stopped-session-store.js";

export const SESSION_ANNOTATIONS_STORAGE_KEY = "webblackbox.runtime.sessionAnnotations";

export type AnnotationLocalAreaLike = {
  remove?(keys: string | string[]): Promise<void>;
};

export type SessionAnnotationsDeps = {
  sessionStorageArea: SnapshotStorageAreaLike | undefined;
  localStorageArea: AnnotationLocalAreaLike | undefined;
  getRuntimeBySid: (sid: string) => SessionRuntime | undefined;
  pushSessionList: () => void;
};

export type SessionAnnotationsController = {
  get: (sid: string) => SessionAnnotation;
  update: (sid: string, tagsInput: unknown, noteInput: unknown) => Promise<void>;
  /** Forgets the annotation; resolves to whether one existed. */
  remove: (sid: string) => Promise<boolean>;
  load: () => Promise<void>;
};

/**
 * Tags and notes describe recordings that do not survive a browser restart, so they live in the
 * in-memory `storage.session` area too; a copy left on disk by older builds is removed.
 */
export function createSessionAnnotations(
  deps: SessionAnnotationsDeps
): SessionAnnotationsController {
  const sessionAnnotations = new Map<string, SessionAnnotation>();

  function get(sid: string): SessionAnnotation {
    const annotation = sessionAnnotations.get(sid);

    if (!annotation) {
      return {
        tags: []
      };
    }

    return {
      tags: [...annotation.tags],
      note: annotation.note
    };
  }

  async function update(sid: string, tagsInput: unknown, noteInput: unknown): Promise<void> {
    const tags = normalizeSessionTags(tagsInput);
    const note = normalizeSessionNote(noteInput);
    const runtime = deps.getRuntimeBySid(sid);

    if (runtime) {
      runtime.tags = [...tags];
      runtime.note = note;
    }

    sessionAnnotations.set(sid, {
      tags: [...tags],
      note
    });

    await persistSessionAnnotations();
    deps.pushSessionList();
  }

  async function remove(sid: string): Promise<boolean> {
    if (!sessionAnnotations.delete(sid)) {
      return false;
    }

    await persistSessionAnnotations();
    return true;
  }

  async function load(): Promise<void> {
    sessionAnnotations.clear();
    await deps.localStorageArea?.remove?.(SESSION_ANNOTATIONS_STORAGE_KEY).catch((error) => {
      console.warn("[WebBlackbox] failed to remove legacy session annotations", error);
    });

    const area = deps.sessionStorageArea;

    if (!area) {
      return;
    }

    const values = await area.get(SESSION_ANNOTATIONS_STORAGE_KEY).catch((error: unknown) => {
      console.warn("[WebBlackbox] failed to read session annotations", error);
      return undefined;
    });
    const raw = asRecord(values?.[SESSION_ANNOTATIONS_STORAGE_KEY]);

    if (!raw) {
      return;
    }

    for (const [sid, payload] of Object.entries(raw)) {
      const row = asRecord(payload);
      const tags = normalizeSessionTags(row?.tags);
      const note = normalizeSessionNote(row?.note);

      sessionAnnotations.set(sid, {
        tags,
        note
      });
    }
  }

  async function persistSessionAnnotations(): Promise<void> {
    const area = deps.sessionStorageArea;

    if (!area) {
      return;
    }

    const serialized: Record<string, SessionAnnotation> = {};

    for (const [sid, annotation] of sessionAnnotations.entries()) {
      serialized[sid] = {
        tags: [...annotation.tags],
        note: annotation.note
      };
    }

    await area
      .set({
        [SESSION_ANNOTATIONS_STORAGE_KEY]: serialized
      })
      .catch((error: unknown) => {
        console.warn("[WebBlackbox] failed to persist session annotations", error);
      });
  }

  return {
    get,
    update,
    remove,
    load
  };
}

function normalizeSessionTags(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const seen = new Set<string>();
  const tags: string[] = [];

  for (const raw of input) {
    if (typeof raw !== "string") {
      continue;
    }

    const normalized = raw.trim().slice(0, 40);

    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    tags.push(normalized);

    if (tags.length >= 12) {
      break;
    }
  }

  return tags;
}

function normalizeSessionNote(input: unknown): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }

  const normalized = input.trim();

  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.slice(0, 500);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
