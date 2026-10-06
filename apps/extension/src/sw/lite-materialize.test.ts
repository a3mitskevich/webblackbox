import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  type CapturePolicy
} from "@webblackbox/protocol";
import { createDefaultRecorderPlugins, type RawRecorderEvent } from "@webblackbox/recorder";
import { describe, expect, it } from "vitest";

import { DEFAULT_PERFORMANCE_BUDGET } from "../shared/performance-budget.js";
import { createDefaultProfile } from "../shared/profiles/presets.js";
import { FullBodyCapture } from "./full-body-capture.js";
import {
  materializeLiteContentEvent,
  resolveLiteBodyCaptureRule,
  resolveProfileBodyMimeAllowlist,
  shouldMaterializeLiteContentEvent
} from "./lite-materialize.js";
import type { SessionPipelineClient } from "./offscreen-client.js";
import { createSessionRuntime, type SessionRuntime } from "./session-registry.js";

const TAB_ID = 7;
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from([1, 2, 3, 4]).toString("base64")}`;

function createPipelineStub(): SessionPipelineClient & {
  blobs: Array<{ mime: string; bytes: Uint8Array }>;
} {
  const blobs: Array<{ mime: string; bytes: Uint8Array }> = [];

  return {
    blobs,
    start: () => Promise.resolve(),
    ingest: () => Promise.resolve(),
    ingestBatch: () => Promise.resolve(0),
    flush: () => Promise.resolve(),
    putBlob: (mime, bytes) => {
      blobs.push({ mime, bytes });
      return Promise.resolve(`blob-${blobs.length}`);
    },
    exportAndDownload: () => Promise.reject(new Error("not implemented")),
    close: () => Promise.resolve()
  };
}

function createRuntime(
  overrides: {
    mode?: "lite" | "full";
    config?: typeof DEFAULT_RECORDER_CONFIG;
  } = {}
): SessionRuntime {
  return createSessionRuntime(
    {
      sid: "S-lite-materialize",
      tabId: TAB_ID,
      mode: overrides.mode ?? "lite",
      profile: {
        request: "auto",
        selection: {
          profile: createDefaultProfile(),
          source: "default",
          extended: false
        },
        profileConfig: DEFAULT_RECORDER_CONFIG,
        visualsCaptured: { screenshots: true, screenRecordings: false }
      },
      url: "https://example.test/app",
      annotation: { tags: [] },
      config: overrides.config ?? DEFAULT_RECORDER_CONFIG,
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

function bodyCaptureConfig(): typeof DEFAULT_RECORDER_CONFIG {
  return {
    ...DEFAULT_RECORDER_CONFIG,
    sampling: {
      ...DEFAULT_RECORDER_CONFIG.sampling,
      bodyCaptureMaxBytes: 64 * 1024
    }
  };
}

function configWithCategories(
  categories: Partial<CapturePolicy["categories"]>
): typeof DEFAULT_RECORDER_CONFIG {
  return {
    ...DEFAULT_RECORDER_CONFIG,
    capturePolicy: {
      ...DEFAULT_CAPTURE_POLICY,
      categories: {
        ...DEFAULT_CAPTURE_POLICY.categories,
        ...categories
      }
    }
  };
}

function createRawEvent(rawType: string, payload: Record<string, unknown>): RawRecorderEvent {
  return {
    source: "content",
    rawType,
    sid: "S-lite-materialize",
    tabId: TAB_ID,
    t: 100,
    mono: 100,
    payload
  };
}

describe("shouldMaterializeLiteContentEvent", () => {
  it("accepts the lite artifact raw types with well-formed payloads in lite mode", () => {
    const runtime = createRuntime();

    expect(
      shouldMaterializeLiteContentEvent(
        runtime,
        createRawEvent("screenshot", { dataUrl: PNG_DATA_URL })
      )
    ).toBe(true);
    expect(
      shouldMaterializeLiteContentEvent(runtime, createRawEvent("snapshot", { html: "<html/>" }))
    ).toBe(true);
    expect(
      shouldMaterializeLiteContentEvent(runtime, createRawEvent("localStorageSnapshot", {}))
    ).toBe(true);
    expect(
      shouldMaterializeLiteContentEvent(runtime, createRawEvent("indexedDbSnapshot", {}))
    ).toBe(true);
    expect(shouldMaterializeLiteContentEvent(runtime, createRawEvent("cookieSnapshot", {}))).toBe(
      true
    );
    expect(
      shouldMaterializeLiteContentEvent(
        runtime,
        createRawEvent("networkBody", { reqId: "1", body: "{}" })
      )
    ).toBe(true);
  });

  it("rejects other raw types, missing payloads and non-content sources", () => {
    const runtime = createRuntime();

    expect(shouldMaterializeLiteContentEvent(runtime, createRawEvent("click", {}))).toBe(false);
    expect(shouldMaterializeLiteContentEvent(runtime, createRawEvent("screenshot", {}))).toBe(
      false
    );
    expect(shouldMaterializeLiteContentEvent(runtime, createRawEvent("snapshot", {}))).toBe(false);
    expect(
      shouldMaterializeLiteContentEvent(
        runtime,
        createRawEvent("networkBody", { reqId: "1", body: 5 })
      )
    ).toBe(false);
    expect(
      shouldMaterializeLiteContentEvent(runtime, {
        ...createRawEvent("snapshot", { html: "<html/>" }),
        source: "system"
      })
    ).toBe(false);
  });

  it("keeps only the profile-kept page events in full mode", () => {
    const fullDefault = createRuntime({ mode: "full" });

    expect(
      shouldMaterializeLiteContentEvent(
        fullDefault,
        createRawEvent("snapshot", { html: "<html/>" })
      )
    ).toBe(false);
    expect(
      shouldMaterializeLiteContentEvent(fullDefault, createRawEvent("localStorageSnapshot", {}))
    ).toBe(false);

    const fullRawDom = createRuntime({
      mode: "full",
      config: configWithCategories({ dom: "allow" })
    });
    expect(
      shouldMaterializeLiteContentEvent(fullRawDom, createRawEvent("snapshot", { html: "<h/>" }))
    ).toBe(true);

    const fullStorage = createRuntime({
      mode: "full",
      config: configWithCategories({ storage: "names-only" })
    });
    expect(
      shouldMaterializeLiteContentEvent(fullStorage, createRawEvent("localStorageSnapshot", {}))
    ).toBe(true);
  });
});

describe("materializeLiteContentEvent", () => {
  it("stores screenshot bytes as a blob and keeps metadata on the event", async () => {
    const runtime = createRuntime();
    const pipeline = runtime.pipeline as ReturnType<typeof createPipelineStub>;
    const result = await materializeLiteContentEvent(
      runtime,
      createRawEvent("screenshot", {
        dataUrl: PNG_DATA_URL,
        w: 800,
        h: 600,
        reason: "interval",
        viewport: { width: 800, height: 600, dpr: 2 }
      })
    );

    expect(pipeline.blobs).toHaveLength(1);
    expect(pipeline.blobs[0]?.mime).toBe("image/png");
    expect(result?.payload).toMatchObject({
      shotId: "blob-1",
      format: "png",
      w: 800,
      h: 600,
      size: 4,
      reason: "interval",
      viewport: { width: 800, height: 600, dpr: 2 }
    });
    expect(result?.payload).not.toHaveProperty("dataUrl");
  });

  it("drops screenshots beyond the data-url budget", async () => {
    const runtime = createRuntime();
    const hugeDataUrl = `data:image/png;base64,${"A".repeat(12 * 1024 * 1024 + 1)}`;

    expect(
      shouldMaterializeLiteContentEvent(
        runtime,
        createRawEvent("screenshot", { dataUrl: hugeDataUrl })
      )
    ).toBe(true);
    await expect(
      materializeLiteContentEvent(runtime, createRawEvent("screenshot", { dataUrl: hugeDataUrl }))
    ).resolves.toBeNull();
  });

  it("stores the DOM snapshot html as a blob with a fallback snapshot id", async () => {
    const runtime = createRuntime();
    const pipeline = runtime.pipeline as ReturnType<typeof createPipelineStub>;
    const result = await materializeLiteContentEvent(
      runtime,
      createRawEvent("snapshot", { html: "<html><body>hi</body></html>", nodeCount: 3 })
    );

    expect(pipeline.blobs[0]?.mime).toBe("text/html");
    expect(result?.payload).toMatchObject({
      snapshotId: "D-100",
      contentHash: "blob-1",
      source: "html",
      nodeCount: 3,
      htmlLength: 28,
      truncated: false
    });
  });

  it("materializes utf8 network bodies under the lite body capture rule", async () => {
    const runtime = createRuntime({ config: bodyCaptureConfig() });
    const result = await materializeLiteContentEvent(
      runtime,
      createRawEvent("networkBody", {
        reqId: "42",
        body: '{"ok":true}',
        encoding: "utf8",
        url: "https://example.test/api",
        mimeType: "application/json; charset=utf-8"
      })
    );

    expect(result?.payload).toMatchObject({
      reqId: "42",
      requestId: "42",
      contentHash: "blob-1",
      mimeType: "application/json",
      size: 11,
      sampledSize: 11,
      truncated: false,
      redacted: false
    });
  });

  it("materializes base64 network bodies", async () => {
    const runtime = createRuntime({ config: bodyCaptureConfig() });
    const body = Buffer.from("plain text body", "utf8").toString("base64");
    const result = await materializeLiteContentEvent(
      runtime,
      createRawEvent("networkBody", {
        reqId: "7",
        body,
        encoding: "base64",
        url: "https://example.test/api",
        mimeType: "text/plain"
      })
    );

    expect(result?.payload).toMatchObject({
      reqId: "7",
      contentHash: "blob-1",
      mimeType: "text/plain",
      size: 15
    });
  });

  it("drops network bodies the body capture rule leaves out", async () => {
    const disabled = createRuntime();
    expect(
      await materializeLiteContentEvent(
        disabled,
        createRawEvent("networkBody", {
          reqId: "1",
          body: "{}",
          url: "https://example.test/api",
          mimeType: "application/json"
        })
      )
    ).toBeNull();

    const wrongMime = createRuntime({ config: bodyCaptureConfig() });
    expect(
      await materializeLiteContentEvent(
        wrongMime,
        createRawEvent("networkBody", {
          reqId: "1",
          body: "AAAA",
          encoding: "base64",
          url: "https://example.test/image.png",
          mimeType: "image/png"
        })
      )
    ).toBeNull();
  });

  it("normalizes storage snapshots inline without blobs", async () => {
    const runtime = createRuntime();
    const pipeline = runtime.pipeline as ReturnType<typeof createPipelineStub>;
    const result = await materializeLiteContentEvent(
      runtime,
      createRawEvent("localStorageSnapshot", {
        count: 1,
        entries: {
          token: { length: 19, sample: "storage-secret-token" }
        }
      })
    );

    expect(pipeline.blobs).toHaveLength(0);
    expect(result?.payload).toMatchObject({ count: 1, mode: "counts-only" });
    expect(JSON.stringify(result)).not.toContain("storage-secret-token");
  });
});

describe("resolveLiteBodyCaptureRule", () => {
  it("is disabled when the profile captures no bodies", () => {
    const runtime = createRuntime();

    expect(
      resolveLiteBodyCaptureRule(runtime, "https://example.test/api", "application/json")
    ).toMatchObject({ enabled: false });
  });

  it("uses the default MIME allowlist and budget once body capture has a budget", () => {
    const runtime = createRuntime({ config: bodyCaptureConfig() });
    const rule = resolveLiteBodyCaptureRule(
      runtime,
      "https://example.test/api",
      "application/json"
    );

    expect(rule.enabled).toBe(true);
    expect(rule.maxBytes).toBe(64 * 1024);
    expect(rule.mimeAllowlist).toContain("application/json");
  });

  it("never enables bodies for browser-internal URLs", () => {
    const runtime = createRuntime({ config: bodyCaptureConfig() });
    const rule = resolveLiteBodyCaptureRule(
      runtime,
      "chrome-extension://abc/content.js",
      "application/javascript"
    );

    expect(rule.enabled).toBe(false);
  });
});

describe("resolveProfileBodyMimeAllowlist", () => {
  it("falls back to the engine default when the profile sets no allowlist", () => {
    const runtime = createRuntime();

    expect(resolveProfileBodyMimeAllowlist(runtime, ["text/*"])).toEqual(["text/*"]);
  });
});
