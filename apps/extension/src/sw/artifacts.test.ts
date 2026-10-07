import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  type CapturePolicy
} from "@webblackbox/protocol";
import { createDefaultRecorderPlugins } from "@webblackbox/recorder";
import { describe, expect, it, vi } from "vitest";

import type { ExtensionOutboundMessage } from "../shared/messages.js";
import { DEFAULT_PERFORMANCE_BUDGET } from "../shared/performance-budget.js";
import { createDefaultProfile } from "../shared/profiles/presets.js";
import {
  createArtifactsController,
  type ArtifactsController,
  type ArtifactsDeps
} from "./artifacts.js";
import { FullBodyCapture } from "./full-body-capture.js";
import type { SessionPipelineClient } from "./offscreen-client.js";
import { createSessionRuntime, type SessionRuntime } from "./session-registry.js";

const SID = "S-1";
const TAB_ID = 7;

function createPipelineStub(): SessionPipelineClient {
  return {
    start: () => Promise.resolve(),
    ingest: () => Promise.resolve(),
    ingestBatch: () => Promise.resolve(0),
    flush: () => Promise.resolve(),
    putBlob: () => Promise.resolve("blob-hash"),
    exportAndDownload: () => Promise.reject(new Error("not implemented")),
    close: () => Promise.resolve()
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

type CaptureCall = { capture: string; reason: string };

function createHarness(): {
  controller: ArtifactsController;
  calls: CaptureCall[];
  broadcasts: ExtensionOutboundMessage[];
  freezeBadgeCount: () => number;
} {
  const calls: CaptureCall[] = [];
  const broadcasts: ExtensionOutboundMessage[] = [];
  const setFreezeBadge = vi.fn(() => Promise.resolve());
  const record = (capture: string) => (_runtime: SessionRuntime, reason: string) => {
    calls.push({ capture, reason });
    return Promise.resolve();
  };
  const deps: ArtifactsDeps = {
    captureScreenshot: record("screenshot"),
    captureTraceMetrics: record("trace"),
    captureAdvancedProfiles: record("advanced"),
    captureStorageSnapshots: record("storage"),
    captureCookieValues: record("cookies"),
    broadcast: (message) => {
      broadcasts.push(message);
    },
    setFreezeBadge
  };

  return {
    controller: createArtifactsController(deps),
    calls,
    broadcasts,
    freezeBadgeCount: () => setFreezeBadge.mock.calls.length
  };
}

describe("shouldCaptureIncidentArtifacts", () => {
  it("rejects a session that is stopping", () => {
    const { controller } = createHarness();
    const runtime = createRuntime({
      config: configWithCategories({ screenshots: "allow" })
    });
    runtime.stopping = true;

    expect(controller.shouldCaptureIncidentArtifacts(runtime)).toBe(false);
  });

  it("rejects when neither screenshots nor full CDP are captured", () => {
    const { controller } = createHarness();
    const runtime = createRuntime({
      config: configWithCategories({ screenshots: "off", cdp: "safe-subset" })
    });

    expect(controller.shouldCaptureIncidentArtifacts(runtime)).toBe(false);
  });

  it("allows full-CDP sessions even with screenshots off", () => {
    const { controller } = createHarness();
    const runtime = createRuntime({
      config: configWithCategories({ screenshots: "off", cdp: "full" })
    });

    expect(controller.shouldCaptureIncidentArtifacts(runtime)).toBe(true);
  });

  it("cools down for 15s after an incident capture", () => {
    const { controller } = createHarness();
    const runtime = createRuntime({
      config: configWithCategories({ screenshots: "allow" })
    });

    expect(controller.shouldCaptureIncidentArtifacts(runtime)).toBe(true);
    expect(controller.shouldCaptureIncidentArtifacts(runtime)).toBe(false);

    runtime.lastIncidentCaptureAt = Date.now() - 15_000;

    expect(controller.shouldCaptureIncidentArtifacts(runtime)).toBe(true);
  });
});

describe("captureIncidentArtifacts", () => {
  it("captures a screenshot and trace metrics, tolerating failures", async () => {
    const calls: CaptureCall[] = [];
    const { controller } = createHarness();
    const failing = createArtifactsController({
      captureScreenshot: () => Promise.reject(new Error("cdp gone")),
      captureTraceMetrics: (_runtime, reason) => {
        calls.push({ capture: "trace", reason });
        return Promise.resolve();
      },
      captureAdvancedProfiles: () => Promise.resolve(),
      captureStorageSnapshots: () => Promise.resolve(),
      captureCookieValues: () => Promise.resolve(),
      broadcast: () => undefined,
      setFreezeBadge: () => Promise.resolve()
    });
    const runtime = createRuntime();

    await failing.captureIncidentArtifacts(runtime, "Network.loadingFailed");
    await controller.captureIncidentArtifacts(runtime, "Runtime.exceptionThrown");

    expect(calls).toEqual([{ capture: "trace", reason: "Network.loadingFailed" }]);
  });
});

describe("captureFullModeArtifacts", () => {
  it("captures screenshot, trace and storage snapshots for a regular reason", async () => {
    const { controller, calls } = createHarness();
    const runtime = createRuntime();

    await controller.captureFullModeArtifacts(runtime, "manual-stop");

    expect(calls).toEqual([
      { capture: "screenshot", reason: "manual-stop" },
      { capture: "trace", reason: "manual-stop" },
      { capture: "storage", reason: "manual-stop" }
    ]);
  });

  it("skips the storage snapshots at session start", async () => {
    const { controller, calls } = createHarness();
    const runtime = createRuntime();

    await controller.captureFullModeArtifacts(runtime, "session-start");

    expect(calls).toEqual([
      { capture: "screenshot", reason: "session-start" },
      { capture: "trace", reason: "session-start" }
    ]);
  });

  it("captures cookie values at session start when the policy allows them", async () => {
    const { controller, calls } = createHarness();
    const runtime = createRuntime({
      config: configWithCategories({ cookies: "allow" })
    });

    await controller.captureFullModeArtifacts(runtime, "session-start");

    expect(calls).toEqual([
      { capture: "screenshot", reason: "session-start" },
      { capture: "trace", reason: "session-start" },
      { capture: "cookies", reason: "session-start" }
    ]);
  });

  it("adds the advanced profiles only for a manual reason", async () => {
    const { controller, calls } = createHarness();
    const runtime = createRuntime();

    await controller.captureFullModeArtifacts(runtime, "manual");

    expect(calls).toContainEqual({ capture: "advanced", reason: "manual" });
    expect(calls).toContainEqual({ capture: "storage", reason: "manual" });
  });
});

describe("handleFreezeNotice", () => {
  it("broadcasts the freeze and highlights the badge", () => {
    const { controller, broadcasts, freezeBadgeCount } = createHarness();
    const runtime = createRuntime();

    controller.handleFreezeNotice(runtime, "error");

    expect(broadcasts).toEqual([{ kind: "sw.freeze", sid: SID, reason: "error" }]);
    expect(freezeBadgeCount()).toBe(1);
    expect(runtime.lastFreezeNotices.get("error")).toBeTypeOf("number");
  });

  it("does nothing for a session that is stopping", () => {
    const { controller, broadcasts, freezeBadgeCount } = createHarness();
    const runtime = createRuntime();
    runtime.stopping = true;

    controller.handleFreezeNotice(runtime, "error");

    expect(broadcasts).toEqual([]);
    expect(freezeBadgeCount()).toBe(0);
  });

  it("cools down per reason for 20s", () => {
    const { controller, broadcasts } = createHarness();
    const runtime = createRuntime();

    controller.handleFreezeNotice(runtime, "error");
    controller.handleFreezeNotice(runtime, "error");
    controller.handleFreezeNotice(runtime, "network");

    expect(broadcasts).toEqual([
      { kind: "sw.freeze", sid: SID, reason: "error" },
      { kind: "sw.freeze", sid: SID, reason: "network" }
    ]);

    runtime.lastFreezeNotices.set("error", Date.now() - 20_000);
    controller.handleFreezeNotice(runtime, "error");

    expect(broadcasts).toHaveLength(3);
  });
});
