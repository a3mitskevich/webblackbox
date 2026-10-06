import { describe, expect, it } from "vitest";

import type { NetworkBodySkippedPayload } from "@webblackbox/protocol";

import type { BodyCaptureRule } from "./body-capture-utils.js";
import {
  completeRequestPostData,
  FULL_BODY_FETCH_CONCURRENCY,
  FULL_BODY_FETCH_MAX_PENDING,
  FullBodyCapture,
  needsRequestPostData,
  readFailureReason,
  type CdpReadOutcome,
  type FinishedResponse,
  type ResponseBodyRead
} from "./full-body-capture.js";

const LIMIT = 1024 * 1024;
const TEXT_RULE: BodyCaptureRule = {
  enabled: true,
  maxBytes: LIMIT,
  mimeAllowlist: ["text/*", "application/json", "application/javascript"]
};

type Harness = {
  capture: FullBodyCapture;
  skips: NetworkBodySkippedPayload[];
  stored: string[];
  reads: string[];
  release: (requestId: string, outcome?: CdpReadOutcome<ResponseBodyRead>) => void;
  settle: () => Promise<void>;
};

function createHarness(
  options: {
    rule?: (url: string, mimeType: string | undefined) => BodyCaptureRule;
    enabled?: boolean;
    autoRead?: boolean;
  } = {}
): Harness {
  const skips: NetworkBodySkippedPayload[] = [];
  const stored: string[] = [];
  const reads: string[] = [];
  const waiting = new Map<string, (outcome: CdpReadOutcome<ResponseBodyRead>) => void>();

  const capture = new FullBodyCapture({
    isEnabled: () => options.enabled ?? true,
    resolveRule: options.rule ?? (() => TEXT_RULE),
    readResponseBody: (requestId) => {
      reads.push(requestId);

      if (options.autoRead !== false) {
        return Promise.resolve({ ok: true, value: { body: `body-${requestId}` } });
      }

      return new Promise((resolve) => waiting.set(requestId, resolve));
    },
    storeBody: async (response, read) => {
      stored.push(`${response.requestId}:${read.body}`);
      return read.body.length;
    },
    emitSkip: (payload) => skips.push(payload)
  });

  return {
    capture,
    skips,
    stored,
    reads,
    release: (requestId, outcome = { ok: true, value: { body: `body-${requestId}` } }) => {
      waiting.get(requestId)?.(outcome);
      waiting.delete(requestId);
    },
    settle: async () => {
      for (let round = 0; round < 10; round += 1) {
        await Promise.resolve();
      }
    }
  };
}

function finished(
  requestId: string,
  meta: Partial<NonNullable<FinishedResponse["meta"]>> | null = {},
  encodedDataLength = 1_400
): FinishedResponse {
  return {
    requestId,
    encodedDataLength,
    meta:
      meta === null
        ? undefined
        : {
            url: `https://app.example/api/${requestId}`,
            mimeType: "application/json",
            status: 200,
            resourceType: "Fetch",
            updatedAt: 0,
            ...meta
          }
  };
}

describe("FullBodyCapture", () => {
  it("captures every body of a burst far beyond the old 80-per-minute cap", async () => {
    const harness = createHarness();

    for (let index = 0; index < 300; index += 1) {
      harness.capture.onLoadingFinished(finished(`r${index}`));
    }

    await harness.capture.drain(5_000);

    expect(harness.stored).toHaveLength(300);
    expect(harness.skips).toEqual([]);
  });

  it("reads at most a few bodies at once and queues the rest", async () => {
    const harness = createHarness({ autoRead: false });

    for (let index = 0; index < 10; index += 1) {
      harness.capture.onLoadingFinished(finished(`q${index}`));
    }

    expect(harness.reads).toHaveLength(FULL_BODY_FETCH_CONCURRENCY);
    harness.release("q0");
    await harness.settle();
    expect(harness.reads).toHaveLength(FULL_BODY_FETCH_CONCURRENCY + 1);
    expect(harness.stored).toEqual(["q0:body-q0"]);
  });

  it("records a backlog skip once too many bodies wait", () => {
    const harness = createHarness({ autoRead: false });
    const total = FULL_BODY_FETCH_CONCURRENCY + FULL_BODY_FETCH_MAX_PENDING + 2;

    for (let index = 0; index < total; index += 1) {
      harness.capture.onLoadingFinished(finished(`b${index}`));
    }

    expect(harness.skips).toHaveLength(2);
    expect(harness.skips[0]).toMatchObject({ side: "response", reason: "backlog" });
  });

  it("skips binary, bodyless and redirect responses without a record", async () => {
    const harness = createHarness();

    harness.capture.onLoadingFinished(
      finished("img", { resourceType: "Image", mimeType: "image/png" })
    );
    harness.capture.onLoadingFinished(finished("bin", { mimeType: "application/octet-stream" }));
    harness.capture.onLoadingFinished(finished("nc", { status: 204 }));
    harness.capture.onLoadingFinished(finished("redir", { status: 302 }));
    await harness.capture.drain(1_000);

    expect(harness.reads).toEqual([]);
    expect(harness.skips).toEqual([]);
  });

  it("reads a 304 (CDP serves the cached body) and untyped script responses", async () => {
    const harness = createHarness();

    harness.capture.onLoadingFinished(finished("nm", { status: 304 }));
    harness.capture.onLoadingFinished(
      finished("js", { mimeType: undefined, resourceType: "Script" })
    );
    await harness.capture.drain(1_000);

    expect(harness.reads).toEqual(["nm", "js"]);
  });

  it("explains every textual response it does not keep", async () => {
    const harness = createHarness({
      rule: (url, mimeType) =>
        url.includes("/blocked/")
          ? { ...TEXT_RULE, enabled: false }
          : mimeType === "text/csv"
            ? { ...TEXT_RULE, enabled: false, mimeAllowlist: ["application/json"] }
            : TEXT_RULE
    });

    harness.capture.onLoadingFinished(finished("big", { mimeType: "text/javascript" }, LIMIT * 3));
    harness.capture.onLoadingFinished(
      finished("policy", { url: "https://app.example/blocked/x", mimeType: "application/json" })
    );
    harness.capture.onLoadingFinished(finished("csv", { mimeType: "text/csv" }));
    await harness.capture.drain(1_000);

    expect(harness.skips.map((skip) => [skip.reqId, skip.reason])).toEqual([
      ["big", "too-large"],
      ["policy", "filtered"],
      ["csv", "mime-not-allowed"]
    ]);
    expect(harness.skips[0]).toMatchObject({ size: LIMIT * 3, limit: LIMIT });
  });

  it("records read failures with the CDP error and empty bodies", async () => {
    const harness = createHarness({ autoRead: false });

    harness.capture.onLoadingFinished(finished("gone"));
    harness.capture.onLoadingFinished(finished("err"));
    harness.capture.onLoadingFinished(finished("void", {}, 0));
    harness.release("gone", {
      ok: false,
      error: "Request content was evicted from inspector cache"
    });
    harness.release("err", { ok: false, error: "timeout" });
    harness.release("void", { ok: true, value: { body: "" } });
    await harness.settle();

    expect(harness.skips.map((skip) => [skip.reqId, skip.reason, skip.detail])).toEqual([
      ["gone", "not-retained", "Request content was evicted from inspector cache"],
      ["err", "fetch-failed", "timeout"],
      ["void", "empty", undefined]
    ]);
  });

  it("records bodies still waiting at stop as backlog", async () => {
    const harness = createHarness({ autoRead: false });

    for (let index = 0; index < FULL_BODY_FETCH_CONCURRENCY + 2; index += 1) {
      harness.capture.onLoadingFinished(finished(`s${index}`));
    }

    await harness.capture.drain(20);
    harness.release("s0");
    await harness.settle();

    expect(harness.skips).toHaveLength(3);
    expect(new Set(harness.skips.map((skip) => skip.reason))).toEqual(new Set(["backlog"]));
    expect(harness.stored).toEqual([]);
  });

  it("records textual responses still loading at stop as unavailable", async () => {
    const harness = createHarness();

    harness.capture.onResponseReceived(finished("unread"));
    harness.capture.onResponseReceived(finished("done"));
    harness.capture.onResponseReceived(finished("failed"));
    harness.capture.onResponseReceived(finished("png", { mimeType: "image/png" }));
    harness.capture.onLoadingFinished(finished("done"));
    harness.capture.onLoadingFailed("failed", undefined);
    await harness.capture.drain(1_000);

    expect(harness.stored).toEqual(["done:body-done"]);
    expect(harness.skips.map((skip) => [skip.reqId, skip.reason])).toEqual([
      ["unread", "unavailable"]
    ]);
  });

  it("tells an empty body from bytes the browser did not hand over", async () => {
    const harness = createHarness({ autoRead: false });

    harness.capture.onLoadingFinished(finished("zero", { headerBytes: 180 }, 180));
    harness.capture.onLoadingFinished(finished("streamed", { headerBytes: 180 }, 244));
    harness.release("zero", { ok: true, value: { body: "" } });
    harness.release("streamed", { ok: true, value: { body: "" } });
    await harness.settle();

    expect(harness.skips.map((skip) => [skip.reqId, skip.reason, skip.size])).toEqual([
      ["zero", "empty", 0],
      ["streamed", "unavailable", 64]
    ]);
  });

  it("uses the metadata kept at response time when the shared map expired it", async () => {
    const harness = createHarness();

    harness.capture.onResponseReceived(finished("long-poll"));
    harness.capture.onLoadingFinished(finished("long-poll", null));
    await harness.capture.drain(1_000);

    expect(harness.stored).toEqual(["long-poll:body-long-poll"]);
  });

  it("tells a request in flight when the capture began from a body the browser dropped", async () => {
    const harness = createHarness({ autoRead: false });
    const noResource = { ok: false as const, error: "No resource with given identifier found" };

    // `early` was sent before `Network.enable`: only its response reaches the capture.
    harness.capture.onResponseReceived(finished("early"));
    harness.capture.onRequestWillBeSent("late", undefined);
    harness.capture.onResponseReceived(finished("late"));
    harness.capture.onLoadingFinished(finished("early"));
    harness.capture.onLoadingFinished(finished("late"));
    harness.release("early", noResource);
    harness.release("late", noResource);
    await harness.settle();

    expect(harness.skips.map((skip) => [skip.reqId, skip.reason])).toEqual([
      ["early", "started-before-capture"],
      ["late", "not-retained"]
    ]);
  });

  it("keeps the body of an earlier request when the browser still has it", async () => {
    const harness = createHarness();

    harness.capture.onResponseReceived(finished("early"));
    harness.capture.onLoadingFinished(finished("early"));
    await harness.capture.drain(1_000);

    expect(harness.stored).toEqual(["early:body-early"]);
    expect(harness.skips).toEqual([]);
  });

  it("tracks requests per CDP session", async () => {
    const harness = createHarness({ autoRead: false });

    harness.capture.onRequestWillBeSent("same", "child");
    harness.capture.onResponseReceived(finished("same"));
    harness.capture.onLoadingFinished(finished("same"));
    harness.release("same", { ok: false, error: "No resource with given identifier found" });
    await harness.settle();

    expect(harness.skips.map((skip) => skip.reason)).toEqual(["started-before-capture"]);
  });

  it("reads SVG images as text and leaves data: URLs alone", async () => {
    const harness = createHarness();
    const svg = { resourceType: "Image", mimeType: "image/svg+xml" };

    harness.capture.onLoadingFinished(
      finished("icon", { ...svg, url: "https://app.example/img/icon.svg" })
    );
    harness.capture.onLoadingFinished(
      finished("inline", { ...svg, url: "data:image/svg+xml;base64,PHN2Zy8+" })
    );
    harness.capture.onLoadingFinished(
      finished("json", { resourceType: "Fetch", url: "data:application/json,{}" })
    );
    await harness.capture.drain(1_000);

    expect(harness.reads).toEqual(["icon"]);
    expect(harness.skips).toEqual([]);
  });

  it("leaves responses it never saw to the archive's own record", async () => {
    const harness = createHarness();

    harness.capture.onLoadingFinished(finished("blob", null));
    await harness.capture.drain(1_000);

    expect(harness.reads).toEqual([]);
    expect(harness.skips).toEqual([]);
  });

  it("does nothing when the policy does not ask for bodies", () => {
    const harness = createHarness({ enabled: false });

    harness.capture.onLoadingFinished(finished("off", null));

    expect(harness.reads).toEqual([]);
    expect(harness.skips).toEqual([]);
  });
});

describe("request bodies CDP leaves out", () => {
  const blobRequest = {
    requestId: "p1",
    request: { url: "https://app.example/api/save", method: "POST", hasPostData: true }
  };

  it("detects a body that is announced but not inlined", () => {
    expect(needsRequestPostData(blobRequest)).toBe(true);
    expect(needsRequestPostData({ request: { ...blobRequest.request, postData: '{"a":1}' } })).toBe(
      false
    );
    expect(
      needsRequestPostData({
        request: { ...blobRequest.request, postDataEntries: [{ bytes: "e30=" }] }
      })
    ).toBe(false);
    expect(needsRequestPostData({ request: { method: "GET" } })).toBe(false);
  });

  it("fills the body read through getRequestPostData", async () => {
    const completed = await completeRequestPostData(blobRequest, async () => ({
      ok: true,
      value: { postData: '{"blob":true}' }
    }));

    expect(completed.request).toMatchObject({ postData: '{"blob":true}', hasPostData: true });
  });

  it("says why the body is missing when it cannot be read", async () => {
    const streamed = await completeRequestPostData(blobRequest, async () => ({
      ok: false,
      error: "No post data available for the request"
    }));
    const timedOut = await completeRequestPostData(blobRequest, async () => ({
      ok: false,
      error: "timeout"
    }));

    expect((streamed.request as Record<string, unknown>).postDataSkipped).toBe("unavailable");
    expect((timedOut.request as Record<string, unknown>).postDataSkipped).toBe("fetch-failed");
  });

  it("classifies CDP read errors", () => {
    expect(readFailureReason("No resource with given identifier found")).toBe("not-retained");
    expect(readFailureReason("No data found for resource with given identifier")).toBe(
      "not-retained"
    );
    expect(readFailureReason("Request content was evicted from inspector cache")).toBe(
      "not-retained"
    );
    expect(readFailureReason("Target closed")).toBe("fetch-failed");
  });
});
