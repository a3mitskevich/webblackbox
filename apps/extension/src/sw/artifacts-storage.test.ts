import type { CdpRouter, Debuggee } from "@webblackbox/cdp-router";
import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  type CapturePolicy
} from "@webblackbox/protocol";
import { createDefaultRecorderPlugins, type RawRecorderEvent } from "@webblackbox/recorder";
import { describe, expect, it } from "vitest";

import { DEFAULT_PERFORMANCE_BUDGET } from "../shared/performance-budget.js";
import { createDefaultProfile } from "../shared/profiles/presets.js";
import {
  createStorageArtifactsController,
  resolveLocalStorageSnapshotMode,
  type StorageArtifactsController
} from "./artifacts-storage.js";
import { FullBodyCapture } from "./full-body-capture.js";
import type { SessionPipelineClient } from "./offscreen-client.js";
import { createSessionRuntime, type SessionRuntime } from "./session-registry.js";

const SID = "S-1";
const TAB_ID = 7;

type SentCommand = {
  target: Debuggee;
  method: string;
  params?: Record<string, unknown>;
};

function createFakeRouter(
  sendResult?: (method: string, params?: Record<string, unknown>) => unknown
): {
  router: CdpRouter;
  sent: SentCommand[];
} {
  const sent: SentCommand[] = [];
  const router: CdpRouter = {
    attach: () => Promise.resolve(),
    detach: () => Promise.resolve(),
    send: <TResult>(target: Debuggee, method: string, params?: Record<string, unknown>) => {
      sent.push({ target, method, params });
      return Promise.resolve(sendResult?.(method, params) as TResult);
    },
    enableBaseline: () => Promise.resolve(),
    enableAutoAttach: () => Promise.resolve(),
    getAttachedTargets: () => [],
    onEvent: () => () => undefined,
    onDetach: () => () => undefined,
    dispose: () => undefined
  };

  return { router, sent };
}

function createPipelineStub(overrides: Partial<SessionPipelineClient> = {}): SessionPipelineClient {
  return {
    start: () => Promise.resolve(),
    ingest: () => Promise.resolve(),
    ingestBatch: () => Promise.resolve(0),
    flush: () => Promise.resolve(),
    putBlob: () => Promise.resolve("blob-hash"),
    exportAndDownload: () => Promise.reject(new Error("not implemented")),
    close: () => Promise.resolve(),
    ...overrides
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

function createRuntime(
  overrides: { config?: typeof DEFAULT_RECORDER_CONFIG } = {}
): SessionRuntime {
  return createSessionRuntime(
    {
      sid: SID,
      tabId: TAB_ID,
      mode: "full",
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

function createHarness(): {
  controller: StorageArtifactsController;
  ingested: RawRecorderEvent[];
} {
  const ingested: RawRecorderEvent[] = [];
  const controller = createStorageArtifactsController({
    ingestRawEvent: (event) => {
      ingested.push(event);
    }
  });

  return { controller, ingested };
}

describe("rememberVisitedPageUrl", () => {
  it("remembers http(s) pages without their fragment", () => {
    const { controller } = createHarness();
    const runtime = createRuntime();

    controller.rememberVisitedPageUrl(runtime, "https://example.test/app#section");
    controller.rememberVisitedPageUrl(runtime, "chrome://extensions");
    controller.rememberVisitedPageUrl(runtime, "not a url");

    expect([...runtime.visitedPageUrls]).toEqual(["https://example.test/app"]);
  });

  it("dedupes and evicts the oldest url past 20 entries", () => {
    const { controller } = createHarness();
    const runtime = createRuntime();

    for (let index = 0; index < 20; index += 1) {
      controller.rememberVisitedPageUrl(runtime, `https://example.test/page-${index}`);
    }

    controller.rememberVisitedPageUrl(runtime, "https://example.test/page-0");
    expect(runtime.visitedPageUrls.size).toBe(20);

    controller.rememberVisitedPageUrl(runtime, "https://example.test/page-20");

    expect(runtime.visitedPageUrls.size).toBe(20);
    expect(runtime.visitedPageUrls.has("https://example.test/page-0")).toBe(false);
    expect(runtime.visitedPageUrls.has("https://example.test/page-20")).toBe(true);
  });
});

describe("captureCookieValues", () => {
  it("does nothing without a debugger", async () => {
    const { controller, ingested } = createHarness();
    const runtime = createRuntime({
      config: configWithCategories({ cookies: "allow" })
    });

    await controller.captureCookieValues(runtime, "session-stop");

    expect(ingested).toEqual([]);
  });

  it("records every cookie inline with capped values for the visited pages", async () => {
    const longValue = "v".repeat(3_000);
    const { router, sent } = createFakeRouter((method) =>
      method === "Network.getCookies"
        ? {
            cookies: [
              {
                name: "session",
                value: "abc",
                domain: ".example.test",
                path: "/",
                httpOnly: true,
                secure: true,
                sameSite: "Lax",
                expires: 1_900_000_000
              },
              { name: "long", value: longValue },
              { name: "broken" }
            ]
          }
        : undefined
    );
    const { controller, ingested } = createHarness();
    const runtime = createRuntime({
      config: configWithCategories({ cookies: "allow" })
    });
    runtime.cdpRouter = router;
    runtime.visitedPageUrls.add("https://example.test/app");

    await controller.captureCookieValues(runtime, "session-stop");

    expect(sent).toEqual([
      {
        target: { tabId: TAB_ID },
        method: "Network.getCookies",
        params: { urls: ["https://example.test/app"] }
      }
    ]);
    expect(ingested).toHaveLength(1);

    const [event] = ingested;
    expect(event?.rawType).toBe("cdp.storage.cookie.snapshot");
    const payload = event?.payload as {
      reason: string;
      count: number;
      truncated: boolean;
      mode: string;
      redacted: boolean;
      cookies: Array<Record<string, unknown>>;
    };
    expect(payload.reason).toBe("session-stop");
    expect(payload.count).toBe(3);
    expect(payload.truncated).toBe(true);
    expect(payload.mode).toBe("allow");
    expect(payload.redacted).toBe(false);
    expect(payload.cookies).toHaveLength(2);
    expect(payload.cookies[0]).toEqual({
      name: "session",
      value: "abc",
      domain: ".example.test",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      expires: 1_900_000_000
    });

    const long = payload.cookies[1];
    expect(long?.name).toBe("long");
    expect(typeof long?.value).toBe("string");
    expect((long?.value as string).length).toBeLessThan(longValue.length);
    expect(long?.valueTruncated).toBe(true);
  });

  it("still runs while the session stops, unlike other artifact reads", async () => {
    const { router } = createFakeRouter((method) =>
      method === "Network.getCookies" ? { cookies: [] } : undefined
    );
    const { controller, ingested } = createHarness();
    const runtime = createRuntime({
      config: configWithCategories({ cookies: "allow" })
    });
    runtime.cdpRouter = router;
    runtime.stopping = true;

    await controller.captureCookieValues(runtime, "session-stop");

    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.payload).toMatchObject({ count: 0, truncated: false, cookies: [] });
  });
});

describe("captureStorageSnapshots", () => {
  it("does nothing without a debugger", async () => {
    const { controller, ingested } = createHarness();
    const runtime = createRuntime();

    await controller.captureStorageSnapshots(runtime, "manual");

    expect(ingested).toEqual([]);
  });

  it("captures nothing when the page agent records no storage details", async () => {
    const { router, sent } = createFakeRouter();
    const { controller, ingested } = createHarness();
    const runtime = createRuntime({
      config: configWithCategories({
        cookies: "count-only",
        storage: "counts-only",
        indexedDb: "counts-only"
      })
    });
    runtime.cdpRouter = router;

    await controller.captureStorageSnapshots(runtime, "manual");

    expect(sent).toEqual([]);
    expect(ingested).toEqual([]);
  });

  it("stores only cookie names in a blob for names-only cookies", async () => {
    const { router } = createFakeRouter((method) =>
      method === "Network.getCookies"
        ? {
            cookies: [
              { name: "session", value: "secret" },
              { name: "prefs", value: "x" }
            ]
          }
        : undefined
    );
    const blobs: Array<{ mime: string; bytes: Uint8Array }> = [];
    const putBlob = (mime: string, bytes: Uint8Array): Promise<string> => {
      blobs.push({ mime, bytes });
      return Promise.resolve("names-hash");
    };
    const { controller, ingested } = createHarness();
    const runtime = createRuntime({
      config: configWithCategories({ cookies: "names-only" })
    });
    runtime.cdpRouter = router;
    runtime.pipeline = createPipelineStub({ putBlob });

    await controller.captureStorageSnapshots(runtime, "manual");

    expect(blobs).toHaveLength(1);
    const blob = blobs[0] as { mime: string; bytes: Uint8Array };
    expect(blob.mime).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(blob.bytes))).toEqual(["session", "prefs"]);

    const [event] = ingested;
    expect(event?.rawType).toBe("cdp.storage.cookie.snapshot");
    expect(event?.payload).toMatchObject({
      hash: "names-hash",
      count: 2,
      sampledCount: 2,
      truncated: false,
      redacted: true,
      reason: "manual"
    });
  });

  it("delegates to the inline cookie values for allow cookies", async () => {
    const { router } = createFakeRouter((method) =>
      method === "Network.getCookies" ? { cookies: [{ name: "a", value: "1" }] } : undefined
    );
    const { controller, ingested } = createHarness();
    const runtime = createRuntime({
      config: configWithCategories({ cookies: "allow" })
    });
    runtime.cdpRouter = router;

    await controller.captureStorageSnapshots(runtime, "manual");

    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.payload).toMatchObject({ mode: "allow", redacted: false });
  });

  it("leaves localStorage and IndexedDB to the page agent when it records storage", async () => {
    const { router, sent } = createFakeRouter();
    const { controller, ingested } = createHarness();
    const runtime = createRuntime({
      config: configWithCategories({ storage: "allow", indexedDb: "names-only" })
    });
    runtime.cdpRouter = router;

    await controller.captureStorageSnapshots(runtime, "manual");

    expect(
      sent.filter(({ method }) => method === "Runtime.evaluate" || method.startsWith("IndexedDB"))
    ).toEqual([]);
    expect(ingested).toEqual([]);
  });
});

describe("resolveLocalStorageSnapshotMode", () => {
  it("maps only the value-capturing storage modes", () => {
    const policy = (storage: CapturePolicy["categories"]["storage"]): CapturePolicy => ({
      ...DEFAULT_CAPTURE_POLICY,
      categories: { ...DEFAULT_CAPTURE_POLICY.categories, storage }
    });

    expect(resolveLocalStorageSnapshotMode(policy("allow"))).toBe("allow");
    expect(resolveLocalStorageSnapshotMode(policy("lengths-only"))).toBe("lengths-only");
    expect(resolveLocalStorageSnapshotMode(policy("names-only"))).toBeNull();
    expect(resolveLocalStorageSnapshotMode(policy("counts-only"))).toBeNull();
    expect(resolveLocalStorageSnapshotMode(undefined)).toBeNull();
  });
});
