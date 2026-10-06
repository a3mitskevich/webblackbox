import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { createDefaultRecorderPlugins, type RawRecorderEvent } from "@webblackbox/recorder";
import { describe, expect, it } from "vitest";

import type { ChromeApi } from "../shared/chrome-api.js";
import { DEFAULT_PERFORMANCE_BUDGET } from "../shared/performance-budget.js";
import { createDefaultProfile } from "../shared/profiles/presets.js";
import { FullBodyCapture } from "./full-body-capture.js";
import {
  createLiteNetworkBaselineController,
  type LiteNetworkBaselineController
} from "./lite-network.js";
import type { SessionPipelineClient } from "./offscreen-client.js";
import { createSessionRuntime, type SessionRuntime } from "./session-registry.js";

const TAB_ID = 7;

type WebRequestDetails = {
  requestId: string;
  tabId: number;
  frameId?: number;
  method?: string;
  url: string;
  statusCode?: number;
  statusLine?: string;
  error?: string;
  timeStamp?: number;
};

type FakeWebRequest = {
  api: NonNullable<ChromeApi["webRequest"]>;
  listeners: {
    beforeRequest: Array<(details: WebRequestDetails) => void>;
    completed: Array<(details: WebRequestDetails) => void>;
    errorOccurred: Array<(details: WebRequestDetails) => void>;
  };
};

function createFakeWebRequest(): FakeWebRequest {
  const listeners: FakeWebRequest["listeners"] = {
    beforeRequest: [],
    completed: [],
    errorOccurred: []
  };

  const registration = (key: keyof FakeWebRequest["listeners"]) => ({
    addListener: (callback: (details: WebRequestDetails) => void) => {
      listeners[key].push(callback);
    },
    removeListener: (callback: (details: WebRequestDetails) => void) => {
      const index = listeners[key].indexOf(callback);

      if (index >= 0) {
        listeners[key].splice(index, 1);
      }
    }
  });

  return {
    api: {
      onBeforeRequest: registration("beforeRequest"),
      onCompleted: registration("completed"),
      onErrorOccurred: registration("errorOccurred")
    },
    listeners
  };
}

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

function createRuntime(overrides: { mode?: "lite" | "full" } = {}): SessionRuntime {
  return createSessionRuntime(
    {
      sid: "S-lite-network",
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

function createHarness(options: { runtimes?: SessionRuntime[]; withWebRequest?: boolean } = {}): {
  controller: LiteNetworkBaselineController;
  webRequest: FakeWebRequest;
  ingested: RawRecorderEvent[];
  runtimes: Map<number, SessionRuntime>;
} {
  const webRequest = createFakeWebRequest();
  const ingested: RawRecorderEvent[] = [];
  const runtimes = new Map<number, SessionRuntime>();

  for (const runtime of options.runtimes ?? []) {
    runtimes.set(runtime.tabId, runtime);
  }

  const controller = createLiteNetworkBaselineController({
    webRequest: options.withWebRequest === false ? undefined : webRequest.api,
    ingestRawEvent: (rawEvent) => {
      ingested.push(rawEvent);
    },
    getRuntimeByTab: (tabId) => runtimes.get(tabId),
    tabRuntimes: () => runtimes.values()
  });

  return { controller, webRequest, ingested, runtimes };
}

describe("lite network baseline controller", () => {
  it("subscribes the three webRequest listeners once", () => {
    const { controller, webRequest } = createHarness();

    controller.install();
    controller.install();

    expect(webRequest.listeners.beforeRequest).toHaveLength(1);
    expect(webRequest.listeners.completed).toHaveLength(1);
    expect(webRequest.listeners.errorOccurred).toHaveLength(1);
  });

  it("does nothing without a webRequest API", () => {
    const { controller, ingested } = createHarness({ withWebRequest: false });

    controller.install();
    controller.uninstallIfUnused();

    expect(ingested).toHaveLength(0);
  });

  it("records request start and end for a lite session, with duration from request metadata", () => {
    const runtime = createRuntime();
    const { controller, webRequest, ingested } = createHarness({ runtimes: [runtime] });

    controller.install();
    webRequest.listeners.beforeRequest[0]?.({
      requestId: "r-1",
      tabId: TAB_ID,
      frameId: 2,
      method: "post",
      url: "https://example.test/api",
      timeStamp: 1_000
    });
    webRequest.listeners.completed[0]?.({
      requestId: "r-1",
      tabId: TAB_ID,
      frameId: 2,
      url: "https://example.test/api",
      statusCode: 200,
      statusLine: "HTTP/1.1 200 OK",
      timeStamp: 1_250
    });

    expect(ingested).toHaveLength(2);
    expect(ingested[0]).toMatchObject({
      rawType: "fetch",
      frame: "content-frame-2",
      payload: { phase: "start", method: "POST", url: "https://example.test/api" }
    });
    expect(ingested[1]).toMatchObject({
      rawType: "fetch",
      payload: {
        phase: "end",
        method: "POST",
        status: 200,
        statusText: "OK",
        duration: 250,
        ok: true
      }
    });
    expect(runtime.requestMeta.size).toBe(0);
  });

  it("records failures with the error message", () => {
    const { controller, webRequest, ingested } = createHarness({ runtimes: [createRuntime()] });

    controller.install();
    webRequest.listeners.errorOccurred[0]?.({
      requestId: "r-2",
      tabId: TAB_ID,
      url: "https://example.test/api",
      error: "net::ERR_CONNECTION_REFUSED",
      timeStamp: 2_000
    });

    expect(ingested).toHaveLength(1);
    expect(ingested[0]).toMatchObject({
      rawType: "fetchError",
      payload: { message: "net::ERR_CONNECTION_REFUSED" }
    });
  });

  it("ignores requests from tabs without an active lite runtime", () => {
    const fullRuntime = createRuntime({ mode: "full" });
    const { controller, webRequest, ingested, runtimes } = createHarness({
      runtimes: [fullRuntime]
    });
    const stoppingRuntime = createRuntime();
    stoppingRuntime.stopping = true;
    runtimes.set(99, stoppingRuntime);

    controller.install();

    for (const tabId of [TAB_ID, 99, 1234, -1]) {
      webRequest.listeners.beforeRequest[0]?.({
        requestId: `r-${tabId}`,
        tabId,
        url: "https://example.test/api",
        timeStamp: 1_000
      });
    }

    expect(ingested).toHaveLength(0);
  });

  it("leaves the main frame without a frame marker", () => {
    const { controller, webRequest, ingested } = createHarness({ runtimes: [createRuntime()] });

    controller.install();
    webRequest.listeners.beforeRequest[0]?.({
      requestId: "r-3",
      tabId: TAB_ID,
      frameId: 0,
      url: "https://example.test/api",
      timeStamp: 1_000
    });

    expect(ingested[0]?.frame).toBeUndefined();
  });

  it("uninstalls once no lite runtime is active, and stays while one is", () => {
    const runtime = createRuntime();
    const { controller, webRequest } = createHarness({ runtimes: [runtime] });

    controller.install();
    controller.uninstallIfUnused();
    expect(webRequest.listeners.beforeRequest).toHaveLength(1);

    runtime.stoppedAt = Date.now();
    controller.uninstallIfUnused();
    expect(webRequest.listeners.beforeRequest).toHaveLength(0);
    expect(webRequest.listeners.completed).toHaveLength(0);
    expect(webRequest.listeners.errorOccurred).toHaveLength(0);

    controller.uninstallIfUnused();
    expect(webRequest.listeners.beforeRequest).toHaveLength(0);
  });

  it("reinstalls after an uninstall", () => {
    const { controller, webRequest, runtimes } = createHarness();

    controller.install();
    controller.uninstallIfUnused();
    expect(webRequest.listeners.beforeRequest).toHaveLength(0);

    runtimes.set(TAB_ID, createRuntime());
    controller.install();
    expect(webRequest.listeners.beforeRequest).toHaveLength(1);
  });
});
