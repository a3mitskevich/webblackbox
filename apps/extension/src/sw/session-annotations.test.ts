import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { createDefaultRecorderPlugins } from "@webblackbox/recorder";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_PERFORMANCE_BUDGET } from "../shared/performance-budget.js";
import { createDefaultProfile } from "../shared/profiles/presets.js";
import { FullBodyCapture } from "./full-body-capture.js";
import type { SessionPipelineClient } from "./offscreen-client.js";
import {
  createSessionAnnotations,
  SESSION_ANNOTATIONS_STORAGE_KEY
} from "./session-annotations.js";
import { createSessionRuntime, type SessionRuntime } from "./session-registry.js";
import type { SnapshotStorageAreaLike } from "./stopped-session-store.js";

type FakeArea = SnapshotStorageAreaLike & {
  read: (key: string) => unknown;
  failNextSet: () => void;
};

function createArea(): FakeArea {
  let stored: Record<string, unknown> = {};
  let failSet = false;

  return {
    get: vi.fn(async (key: string) => (key in stored ? { [key]: stored[key] } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => {
      if (failSet) {
        failSet = false;
        throw new Error("storage unavailable");
      }

      stored = { ...stored, ...items };
    }),
    read: (key: string) => stored[key],
    failNextSet: () => {
      failSet = true;
    }
  };
}

function createPipelineStub(): SessionPipelineClient {
  return {
    start: vi.fn(async () => undefined),
    ingest: vi.fn(async () => undefined),
    ingestBatch: vi.fn(async () => 0),
    flush: vi.fn(async () => undefined),
    putBlob: vi.fn(async () => "blob-id"),
    exportAndDownload: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    close: vi.fn(async () => undefined)
  };
}

function createRuntime(): SessionRuntime {
  return createSessionRuntime(
    {
      sid: "S-1",
      tabId: 7,
      mode: "lite",
      profile: {
        request: "auto",
        selection: { profile: createDefaultProfile(), source: "default", extended: false },
        profileConfig: DEFAULT_RECORDER_CONFIG,
        visualsCaptured: { screenshots: true, screenRecordings: false }
      },
      url: "https://example.test/app",
      annotation: { tags: [] },
      config: DEFAULT_RECORDER_CONFIG,
      startedAt: 1_000,
      pipeline: createPipelineStub(),
      recorderPlugins: createDefaultRecorderPlugins(),
      performanceBudget: { ...DEFAULT_PERFORMANCE_BUDGET }
    },
    {
      createFullBodyCapture: () =>
        new FullBodyCapture({
          isEnabled: () => false,
          resolveRule: () => ({ enabled: false, maxBytes: 0, mimeAllowlist: [] }),
          readResponseBody: () => Promise.resolve({ ok: false, error: "unavailable" }),
          storeBody: () => Promise.resolve(0),
          emitSkip: () => undefined
        })
    }
  );
}

describe("createSessionAnnotations", () => {
  it("returns an empty annotation for an unknown session", () => {
    const annotations = createSessionAnnotations({
      sessionStorageArea: undefined,
      localStorageArea: undefined,
      getRuntimeBySid: () => undefined,
      pushSessionList: () => undefined
    });

    expect(annotations.get("S-missing")).toEqual({ tags: [] });
  });

  it("normalizes tags and the note, updates the live runtime and persists", async () => {
    const area = createArea();
    const runtime = createRuntime();
    const pushSessionList = vi.fn();
    const annotations = createSessionAnnotations({
      sessionStorageArea: area,
      localStorageArea: undefined,
      getRuntimeBySid: () => runtime,
      pushSessionList
    });

    const long = "x".repeat(60);
    await annotations.update(
      "S-1",
      ["  bug  ", "bug", "", 42, long, ...Array.from({ length: 12 }, (_, i) => `t${i}`)],
      "  needs a look  "
    );

    expect(runtime.tags).toHaveLength(12);
    expect(runtime.tags[0]).toBe("bug");
    expect(runtime.tags[1]).toBe("x".repeat(40));
    expect(runtime.note).toBe("needs a look");
    expect(annotations.get("S-1").tags).toEqual(runtime.tags);
    expect(area.read(SESSION_ANNOTATIONS_STORAGE_KEY)).toEqual({
      "S-1": { tags: runtime.tags, note: "needs a look" }
    });
    expect(pushSessionList).toHaveBeenCalledOnce();
  });

  it("drops an empty note instead of storing it", async () => {
    const annotations = createSessionAnnotations({
      sessionStorageArea: createArea(),
      localStorageArea: undefined,
      getRuntimeBySid: () => undefined,
      pushSessionList: () => undefined
    });

    await annotations.update("S-1", [], "   ");
    expect(annotations.get("S-1").note).toBeUndefined();
  });

  it("keeps working when persistence fails", async () => {
    const area = createArea();
    area.failNextSet();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const pushSessionList = vi.fn();
    const annotations = createSessionAnnotations({
      sessionStorageArea: area,
      localStorageArea: undefined,
      getRuntimeBySid: () => undefined,
      pushSessionList
    });

    await annotations.update("S-1", ["bug"], undefined);

    expect(annotations.get("S-1").tags).toEqual(["bug"]);
    expect(pushSessionList).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("remove reports whether an annotation existed and persists the deletion", async () => {
    const area = createArea();
    const annotations = createSessionAnnotations({
      sessionStorageArea: area,
      localStorageArea: undefined,
      getRuntimeBySid: () => undefined,
      pushSessionList: () => undefined
    });

    await annotations.update("S-1", ["bug"], undefined);
    expect(await annotations.remove("S-1")).toBe(true);
    expect(annotations.get("S-1")).toEqual({ tags: [] });
    expect(area.read(SESSION_ANNOTATIONS_STORAGE_KEY)).toEqual({});
    expect(await annotations.remove("S-1")).toBe(false);
  });

  it("load restores annotations, drops the legacy local copy and ignores junk rows", async () => {
    const sessionArea = createArea();
    await sessionArea.set({
      [SESSION_ANNOTATIONS_STORAGE_KEY]: {
        "S-1": { tags: ["bug", 42, " "], note: " kept " },
        "S-2": "not-a-row"
      }
    });
    const remove = vi.fn(async () => undefined);
    const annotations = createSessionAnnotations({
      sessionStorageArea: sessionArea,
      localStorageArea: { remove },
      getRuntimeBySid: () => undefined,
      pushSessionList: () => undefined
    });

    await annotations.load();

    expect(remove).toHaveBeenCalledWith(SESSION_ANNOTATIONS_STORAGE_KEY);
    expect(annotations.get("S-1")).toEqual({ tags: ["bug"], note: "kept" });
    expect(annotations.get("S-2")).toEqual({ tags: [] });
  });
});
