import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { createDefaultRecorderPlugins } from "@webblackbox/recorder";
import { describe, expect, it, vi } from "vitest";

import { normalizeEnterprisePolicy } from "../shared/options-storage.js";
import { DEFAULT_PERFORMANCE_BUDGET } from "../shared/performance-budget.js";
import { createDefaultProfile } from "../shared/profiles/presets.js";
import { FullBodyCapture } from "./full-body-capture.js";
import {
  createNavigationRouter,
  type NavigationRouter,
  type NavigationRouterDeps
} from "./navigation-router.js";
import type { SessionPipelineClient } from "./offscreen-client.js";
import {
  createSessionRegistry,
  createSessionRuntime,
  type SessionRuntime,
  type SessionRuntimeInit
} from "./session-registry.js";

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

function createRuntime(overrides: Partial<SessionRuntimeInit> = {}): SessionRuntime {
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
      url: "https://page.test/app",
      title: "Page",
      annotation: { tags: [] },
      config: DEFAULT_RECORDER_CONFIG,
      startedAt: 1_000,
      pipeline: createPipelineStub(),
      recorderPlugins: createDefaultRecorderPlugins(),
      performanceBudget: { ...DEFAULT_PERFORMANCE_BUDGET },
      ...overrides
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

type Harness = {
  router: NavigationRouter;
  sessionRegistry: ReturnType<typeof createSessionRegistry>;
  deps: NavigationRouterDeps;
};

function createHarness(overrides: Partial<NavigationRouterDeps> = {}): Harness {
  const sessionRegistry = createSessionRegistry();
  const deps: NavigationRouterDeps = {
    sessionRegistry,
    sessionCommands: {
      stopSession: vi.fn(async () => undefined),
      notifyTabStatus: vi.fn(async () => undefined)
    },
    profile: {
      loadSessionProfilesState: vi.fn(),
      loadEnterprisePolicy: vi.fn(async () => normalizeEnterprisePolicy({})),
      resolveTabProfileSelection: vi.fn(async () => null),
      resolveProfilePreview: vi.fn(async () => ({ kind: "sw.profile-preview" }) as never),
      scheduleProfileReevaluation: vi.fn()
    },
    contentInjection: { currentMode: () => "on-start" },
    storageArtifacts: { rememberVisitedPageUrl: vi.fn() },
    tabsContextTracker: null,
    runtime: {
      getManifest: () => ({ permissions: [] })
    },
    scripting: {
      executeScript: vi.fn(async () => undefined)
    },
    pushSessionList: vi.fn(),
    ...overrides
  };

  return {
    router: createNavigationRouter(deps),
    sessionRegistry,
    deps
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("recorded tab navigation", () => {
  it("updates the session url on a same-origin change and pushes the list", async () => {
    const { router, deps, sessionRegistry } = createHarness();
    const runtime = createRuntime();
    sessionRegistry.register(runtime);

    router.handleRecordedTabUpdated(7, { url: "https://page.test/other" });
    await flushMicrotasks();

    expect(runtime.url).toBe("https://page.test/other");
    expect(deps.pushSessionList).toHaveBeenCalled();
    expect(deps.sessionCommands.stopSession).not.toHaveBeenCalled();
    expect(deps.storageArtifacts.rememberVisitedPageUrl).toHaveBeenCalledWith(
      runtime,
      "https://page.test/other"
    );
    expect(deps.profile.scheduleProfileReevaluation).toHaveBeenCalledWith(runtime, "navigation");
  });

  it("stops the session when the origin changes and the policy asks for it", async () => {
    const { router, deps, sessionRegistry } = createHarness();
    const runtime = createRuntime();
    runtime.config = {
      ...runtime.config,
      capturePolicy: {
        ...runtime.config.capturePolicy!,
        scope: { ...runtime.config.capturePolicy!.scope, stopOnOriginChange: true }
      }
    };
    sessionRegistry.register(runtime);

    router.handleRecordedTabUpdated(7, { url: "https://other.test/app" });
    await vi.waitFor(() => {
      expect(deps.sessionCommands.stopSession).toHaveBeenCalledWith(7);
    });
  });

  it("ignores updates for tabs without a recording", async () => {
    const { router, deps } = createHarness();

    router.handleRecordedTabUpdated(7, { url: "https://page.test/other", status: "complete" });
    await flushMicrotasks();

    expect(deps.pushSessionList).not.toHaveBeenCalled();
    expect(deps.sessionCommands.notifyTabStatus).not.toHaveBeenCalled();
  });

  it("restores instrumentation once a recorded tab completes a navigation", async () => {
    const { router, deps, sessionRegistry } = createHarness();
    const runtime = createRuntime();
    sessionRegistry.register(runtime);

    router.handleRecordedTabUpdated(7, { status: "complete" });
    await vi.waitFor(() => {
      expect(deps.sessionCommands.notifyTabStatus).toHaveBeenCalledWith(
        7,
        true,
        "S-1",
        "lite",
        expect.anything(),
        expect.anything(),
        runtime.injectedBridgeNonce,
        expect.anything()
      );
    });
    expect(deps.profile.scheduleProfileReevaluation).toHaveBeenCalledWith(runtime, "page-loaded");
  });

  it("injects the content script into committed frames of a recorded tab", () => {
    const { router, deps, sessionRegistry } = createHarness();
    sessionRegistry.register(createRuntime());

    router.handleRecordedFrameCommitted({ tabId: 7, frameId: 2, url: "https://page.test/frame" });

    expect(deps.scripting?.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 7, frameIds: [2] },
        world: "ISOLATED"
      })
    );
  });

  it("skips frames that are not injectable or not recorded", () => {
    const { router, deps } = createHarness();

    router.handleRecordedFrameCommitted({ tabId: 7, frameId: 0, url: "chrome://settings" });

    expect(deps.scripting?.executeScript).not.toHaveBeenCalled();
  });
});
