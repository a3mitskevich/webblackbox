import type { CdpRouter, Debuggee } from "@webblackbox/cdp-router";
import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  type CapturePolicy
} from "@webblackbox/protocol";
import { createDefaultRecorderPlugins, type RawRecorderEvent } from "@webblackbox/recorder";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_PERFORMANCE_BUDGET } from "../shared/performance-budget.js";
import { createDefaultProfile } from "../shared/profiles/presets.js";
import {
  createScreenshotArtifactsController,
  type ScreenshotArtifactsController
} from "./artifacts-screenshot.js";
import { FullBodyCapture } from "./full-body-capture.js";
import type { SessionPipelineClient } from "./offscreen-client.js";
import { createSessionRuntime, type SessionRuntime } from "./session-registry.js";

const SID = "S-1";
const TAB_ID = 7;
const BEST_EFFORT_QUEUE_MAX_PENDING = 80;

type SentCommand = {
  target: Debuggee;
  method: string;
  params?: Record<string, unknown>;
};

function createFakeRouter(sendResult?: (method: string) => unknown): {
  router: CdpRouter;
  sent: SentCommand[];
} {
  const sent: SentCommand[] = [];
  const router: CdpRouter = {
    attach: () => Promise.resolve(),
    detach: () => Promise.resolve(),
    send: <TResult>(target: Debuggee, method: string, params?: Record<string, unknown>) => {
      sent.push({ target, method, params });
      return Promise.resolve(sendResult?.(method) as TResult);
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
  controller: ScreenshotArtifactsController;
  ingested: RawRecorderEvent[];
} {
  const ingested: RawRecorderEvent[] = [];
  const controller = createScreenshotArtifactsController({
    ingestRawEvent: (event) => {
      ingested.push(event);
    },
    bestEffortQueueMaxPending: BEST_EFFORT_QUEUE_MAX_PENDING
  });

  return { controller, ingested };
}

function actionEvent(rawType: string, mono: number): RawRecorderEvent {
  return {
    source: "content",
    rawType,
    tabId: TAB_ID,
    sid: SID,
    t: 1_000,
    mono,
    payload: {}
  };
}

describe("shouldCaptureActionScreenshot", () => {
  it("accepts a click from the page after the cooldown", () => {
    const { controller } = createHarness();
    const runtime = createRuntime({
      config: configWithCategories({ screenshots: "allow" })
    });

    expect(controller.shouldCaptureActionScreenshot(actionEvent("click", 10_000), runtime)).toBe(
      true
    );
  });

  it("rejects events that did not come from the page", () => {
    const { controller } = createHarness();
    const runtime = createRuntime({
      config: configWithCategories({ screenshots: "allow" })
    });
    const event: RawRecorderEvent = { ...actionEvent("click", 10_000), source: "cdp" };

    expect(controller.shouldCaptureActionScreenshot(event, runtime)).toBe(false);
  });

  it("rejects raw types outside the action set", () => {
    const { controller } = createHarness();
    const runtime = createRuntime({
      config: configWithCategories({ screenshots: "allow" })
    });

    expect(
      controller.shouldCaptureActionScreenshot(actionEvent("mousemove", 10_000), runtime)
    ).toBe(false);
    expect(controller.shouldCaptureActionScreenshot(actionEvent("scroll", 10_000), runtime)).toBe(
      false
    );
    expect(controller.shouldCaptureActionScreenshot(actionEvent("submit", 10_000), runtime)).toBe(
      true
    );
    expect(controller.shouldCaptureActionScreenshot(actionEvent("marker", 10_000), runtime)).toBe(
      true
    );
    expect(controller.shouldCaptureActionScreenshot(actionEvent("dblclick", 10_000), runtime)).toBe(
      true
    );
  });

  it("rejects every action when the policy turns screenshots off", () => {
    const { controller } = createHarness();
    const runtime = createRuntime({
      config: configWithCategories({ screenshots: "off" })
    });

    expect(controller.shouldCaptureActionScreenshot(actionEvent("click", 10_000), runtime)).toBe(
      false
    );
  });

  it("rejects actions inside the 2s cooldown", () => {
    const { controller } = createHarness();
    const runtime = createRuntime({
      config: configWithCategories({ screenshots: "allow" })
    });
    runtime.lastActionScreenshotMono = 9_500;

    expect(controller.shouldCaptureActionScreenshot(actionEvent("click", 10_000), runtime)).toBe(
      false
    );
    expect(controller.shouldCaptureActionScreenshot(actionEvent("click", 11_500), runtime)).toBe(
      true
    );
  });

  it("rejects actions while the session queue is a third full", () => {
    const { controller } = createHarness();
    const runtime = createRuntime({
      config: configWithCategories({ screenshots: "allow" })
    });
    runtime.queueDepth = Math.floor(BEST_EFFORT_QUEUE_MAX_PENDING / 3);

    expect(controller.shouldCaptureActionScreenshot(actionEvent("click", 10_000), runtime)).toBe(
      false
    );

    runtime.queueDepth = Math.floor(BEST_EFFORT_QUEUE_MAX_PENDING / 3) - 1;

    expect(controller.shouldCaptureActionScreenshot(actionEvent("click", 10_000), runtime)).toBe(
      true
    );
  });
});

describe("captureScreenshot", () => {
  it("does nothing without a debugger", async () => {
    const { controller, ingested } = createHarness();
    const runtime = createRuntime({
      config: configWithCategories({ screenshots: "allow" })
    });

    await controller.captureScreenshot(runtime, "interval");

    expect(ingested).toEqual([]);
  });

  it("does nothing when the policy turns screenshots off", async () => {
    const { controller, ingested } = createHarness();
    const { router, sent } = createFakeRouter();
    const runtime = createRuntime({
      config: configWithCategories({ screenshots: "off" })
    });
    runtime.cdpRouter = router;

    await controller.captureScreenshot(runtime, "interval");

    expect(sent).toEqual([]);
    expect(ingested).toEqual([]);
  });

  it("stores the webp blob and records the shot with viewport and pointer", async () => {
    const data = Buffer.from("fake-webp").toString("base64");
    const { router, sent } = createFakeRouter((method) =>
      method === "Page.captureScreenshot" ? { data } : undefined
    );
    const putBlob = vi.fn(() => Promise.resolve("shot-hash"));
    const { controller, ingested } = createHarness();
    const runtime = createRuntime({
      config: configWithCategories({ screenshots: "allow" })
    });
    runtime.cdpRouter = router;
    runtime.pipeline = createPipelineStub({ putBlob });
    runtime.lastViewport = { width: 1280, height: 720, dpr: 2 };
    runtime.lastPointer = { x: 10, y: 20, t: Date.now(), mono: 5_000 };

    await controller.captureScreenshot(runtime, "action:click");

    expect(sent).toEqual([
      {
        target: { tabId: TAB_ID },
        method: "Page.captureScreenshot",
        params: { format: "webp", quality: 62, fromSurface: true }
      }
    ]);
    expect(putBlob).toHaveBeenCalledWith("image/webp", expect.any(Uint8Array));
    expect(ingested).toHaveLength(1);

    const [event] = ingested;
    expect(event?.rawType).toBe("cdp.screen.screenshot");
    expect(event?.source).toBe("system");
    expect(event?.payload).toMatchObject({
      shotId: "shot-hash",
      format: "webp",
      quality: 62,
      w: 1280,
      h: 720,
      viewport: { width: 1280, height: 720, dpr: 2 },
      pointer: { x: 10, y: 20 },
      size: 9,
      reason: "action:click"
    });
  });

  it("drops a pointer older than 2.5s", async () => {
    const data = Buffer.from("x").toString("base64");
    const { router } = createFakeRouter((method) =>
      method === "Page.captureScreenshot" ? { data } : undefined
    );
    const { controller, ingested } = createHarness();
    const runtime = createRuntime({
      config: configWithCategories({ screenshots: "allow" })
    });
    runtime.cdpRouter = router;
    runtime.lastPointer = { x: 10, y: 20, t: Date.now() - 10_000, mono: 5_000 };

    await controller.captureScreenshot(runtime, "interval");

    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.payload).toMatchObject({ pointer: undefined });
  });

  it("records nothing when the CDP read fails", async () => {
    const { controller, ingested } = createHarness();
    const runtime = createRuntime({
      config: configWithCategories({ screenshots: "allow" })
    });
    const router: CdpRouter = {
      attach: () => Promise.resolve(),
      detach: () => Promise.resolve(),
      send: () => Promise.reject(new Error("Debugger is not attached")),
      enableBaseline: () => Promise.resolve(),
      enableAutoAttach: () => Promise.resolve(),
      getAttachedTargets: () => [],
      onEvent: () => () => undefined,
      onDetach: () => () => undefined,
      dispose: () => undefined
    };
    runtime.cdpRouter = router;

    await controller.captureScreenshot(runtime, "interval");

    expect(ingested).toEqual([]);
  });
});
