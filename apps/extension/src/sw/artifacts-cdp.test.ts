import type { CdpRouter, Debuggee } from "@webblackbox/cdp-router";
import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { createDefaultRecorderPlugins } from "@webblackbox/recorder";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PERFORMANCE_BUDGET } from "../shared/performance-budget.js";
import { createDefaultProfile } from "../shared/profiles/presets.js";
import {
  decodeBase64,
  evaluateExpression,
  sendCdpCommand,
  sendCdpCommandOutcome
} from "./artifacts-cdp.js";
import { FullBodyCapture } from "./full-body-capture.js";
import type { SessionPipelineClient } from "./offscreen-client.js";
import { createSessionRuntime, type SessionRuntime } from "./session-registry.js";

const TAB_ID = 7;

type SentCommand = {
  target: Debuggee;
  method: string;
  params?: Record<string, unknown>;
};

function createFakeRouter(send: (method: string) => Promise<unknown>): {
  router: CdpRouter;
  sent: SentCommand[];
} {
  const sent: SentCommand[] = [];
  const router: CdpRouter = {
    attach: () => Promise.resolve(),
    detach: () => Promise.resolve(),
    send: <TResult>(target: Debuggee, method: string, params?: Record<string, unknown>) => {
      sent.push({ target, method, params });
      return send(method) as Promise<TResult>;
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

function createRuntime(router: CdpRouter | null): SessionRuntime {
  const runtime = createSessionRuntime(
    {
      sid: "S-1",
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
  runtime.cdpRouter = router;
  return runtime;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("sendCdpCommandOutcome", () => {
  it("reports a detached debugger without sending when there is no router", async () => {
    const runtime = createRuntime(null);

    await expect(
      sendCdpCommandOutcome(runtime, { tabId: TAB_ID }, "Page.captureScreenshot")
    ).resolves.toEqual({ ok: false, error: "debugger detached" });
  });

  it("stops artifact reads once the session is stopping", async () => {
    const { router, sent } = createFakeRouter(() => Promise.resolve({ data: "x" }));
    const runtime = createRuntime(router);
    runtime.stopping = true;

    await expect(
      sendCdpCommandOutcome(runtime, { tabId: TAB_ID }, "Page.captureScreenshot")
    ).resolves.toEqual({ ok: false, error: "debugger detached" });
    expect(sent).toEqual([]);
  });

  it("forwards the target, method and params and returns the value", async () => {
    const { router, sent } = createFakeRouter(() => Promise.resolve({ data: "x" }));
    const runtime = createRuntime(router);
    const target = { tabId: TAB_ID, sessionId: "child-1" };

    await expect(
      sendCdpCommandOutcome(runtime, target, "Page.captureScreenshot", { format: "webp" })
    ).resolves.toEqual({ ok: true, value: { data: "x" } });
    expect(sent).toEqual([
      { target, method: "Page.captureScreenshot", params: { format: "webp" } }
    ]);
  });

  it("turns a CDP error into a failed outcome", async () => {
    const { router } = createFakeRouter(() => Promise.reject(new Error("No target")));
    const runtime = createRuntime(router);

    await expect(
      sendCdpCommandOutcome(runtime, { tabId: TAB_ID }, "Storage.getCookies")
    ).resolves.toEqual({ ok: false, error: "No target" });
  });

  it("times out a CDP read that never answers", async () => {
    vi.useFakeTimers();
    const { router } = createFakeRouter(() => new Promise<unknown>(() => undefined));
    const runtime = createRuntime(router);

    const outcome = sendCdpCommandOutcome(
      runtime,
      { tabId: TAB_ID },
      "HeapProfiler.takeHeapSnapshot",
      undefined,
      500
    );
    await vi.advanceTimersByTimeAsync(500);

    await expect(outcome).resolves.toEqual({ ok: false, error: "timeout" });
  });
});

describe("sendCdpCommand", () => {
  it("returns the value of a successful read", async () => {
    const { router } = createFakeRouter(() => Promise.resolve({ cookies: [] }));
    const runtime = createRuntime(router);

    await expect(sendCdpCommand(runtime, { tabId: TAB_ID }, "Storage.getCookies")).resolves.toEqual(
      { cookies: [] }
    );
  });

  it("swallows a failed read into undefined", async () => {
    const { router } = createFakeRouter(() => Promise.reject(new Error("No target")));
    const runtime = createRuntime(router);

    await expect(
      sendCdpCommand(runtime, { tabId: TAB_ID }, "Storage.getCookies")
    ).resolves.toBeUndefined();
  });
});

describe("evaluateExpression", () => {
  it("evaluates by value in the session tab and returns the result value", async () => {
    const { router, sent } = createFakeRouter(() => Promise.resolve({ result: { value: 42 } }));
    const runtime = createRuntime(router);

    await expect(evaluateExpression(runtime, "6 * 7")).resolves.toBe(42);
    expect(sent).toEqual([
      {
        target: { tabId: TAB_ID },
        method: "Runtime.evaluate",
        params: { expression: "6 * 7", returnByValue: true, awaitPromise: true }
      }
    ]);
  });

  it("returns undefined without a debugger", async () => {
    const runtime = createRuntime(null);

    await expect(evaluateExpression(runtime, "1")).resolves.toBeUndefined();
  });
});

describe("decodeBase64", () => {
  it("decodes base64 into bytes", () => {
    expect(Array.from(decodeBase64("aGk="))).toEqual([104, 105]);
  });
});
