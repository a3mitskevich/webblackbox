import { describe, expect, it } from "vitest";

import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  type CapturePolicy,
  type RecorderConfig
} from "@webblackbox/protocol";

import { MAX_INLINE_REQUEST_BODY_CHARS } from "./network-body-policy.js";
import { WebBlackboxRecorder, type RecorderHooks } from "./recorder.js";
import type { RawRecorderEvent } from "./types.js";

const BODY_LIMIT_BYTES = 1024 * 1024;

type NetworkPolicy = CapturePolicy["categories"]["network"];

function createRecorder(
  network: NetworkPolicy = "body-allowlist",
  hooks: RecorderHooks = {}
): WebBlackboxRecorder {
  const config: RecorderConfig = {
    ...DEFAULT_RECORDER_CONFIG,
    mode: "full",
    sampling: { ...DEFAULT_RECORDER_CONFIG.sampling, bodyCaptureMaxBytes: BODY_LIMIT_BYTES },
    capturePolicy: {
      ...DEFAULT_CAPTURE_POLICY,
      categories: { ...DEFAULT_CAPTURE_POLICY.categories, network }
    }
  };

  return new WebBlackboxRecorder(config, hooks);
}

function raw(rawType: string, payload: unknown, source: RawRecorderEvent["source"] = "cdp") {
  return {
    source,
    rawType,
    sid: "S-completeness",
    tabId: 1,
    t: 1_700_000_000_000,
    mono: 10,
    payload
  } satisfies RawRecorderEvent;
}

function requestWillBeSent(
  requestId: string,
  url: string,
  request: Record<string, unknown> = {}
): RawRecorderEvent {
  return raw("Network.requestWillBeSent", {
    requestId,
    type: "Fetch",
    request: { url, method: "POST", headers: {}, ...request }
  });
}

function requestOf(event: { data: unknown } | undefined): Record<string, unknown> {
  return (event?.data as { request: Record<string, unknown> }).request;
}

describe("request body completeness", () => {
  it("records why a request body a host rule left out is missing", () => {
    const recorder = createRecorder("body-allowlist", {
      shouldKeepInlineNetworkBody: () => "mime-not-allowed"
    });
    const { event } = recorder.ingest(
      requestWillBeSent("1.1", "https://app.example/api/save", {
        postData: '{"a":1}',
        headers: { "Content-Type": "application/json" }
      })
    );

    expect(requestOf(event).postData).toBeUndefined();
    expect(requestOf(event).postDataSkipped).toBe("mime-not-allowed");
  });

  it("reports a plain `false` from the host gate as filtered", () => {
    const recorder = createRecorder("body-allowlist", {
      shouldKeepInlineNetworkBody: () => false
    });
    const { event } = recorder.ingest(
      requestWillBeSent("1.2", "https://app.example/api/save", { postData: "x=1" })
    );

    expect(requestOf(event).postDataSkipped).toBe("filtered");
  });

  it("says nothing about bodies the policy never asked for", () => {
    const recorder = createRecorder("headers-allowlist");
    const { event } = recorder.ingest(
      requestWillBeSent("1.3", "https://app.example/api/save", { postData: "x=1" })
    );

    expect(requestOf(event).postData).toBeUndefined();
    expect(requestOf(event).postDataSkipped).toBeUndefined();
  });

  it("keeps request bodies up to the profile limit, not the legacy 64K preview", () => {
    const body = JSON.stringify({ rows: "r".repeat(MAX_INLINE_REQUEST_BODY_CHARS * 2) });
    const { event } = createRecorder().ingest(
      requestWillBeSent("1.4", "https://app.example/api/bulk", { postData: body })
    );

    expect(requestOf(event).postData).toBe(body);
    expect(requestOf(event).postDataTruncated).toBeUndefined();
  });

  it("passes a host-reported read failure through when CDP left the body out", () => {
    const { event } = createRecorder().ingest(
      requestWillBeSent("1.5", "https://app.example/api/blob", {
        hasPostData: true,
        postDataSkipped: "not-retained"
      })
    );

    expect(requestOf(event).hasPostData).toBe(true);
    expect(requestOf(event).postDataSkipped).toBe("not-retained");
  });

  it("ignores an unknown skip reason", () => {
    const { event } = createRecorder().ingest(
      requestWillBeSent("1.6", "https://app.example/api/blob", {
        hasPostData: true,
        postDataSkipped: "because"
      })
    );

    expect(requestOf(event).postDataSkipped).toBeUndefined();
  });
});

describe("network.body.skipped", () => {
  it("normalizes a host skip record onto the request", () => {
    const { event } = createRecorder().ingest(
      raw(
        "cdp.network.body.skipped",
        {
          reqId: "2.1",
          side: "response",
          reason: "too-large",
          mimeType: "text/javascript",
          size: 5_000_000,
          limit: BODY_LIMIT_BYTES,
          detail: "d".repeat(500),
          extra: "dropped"
        },
        "system"
      )
    );

    expect(event?.type).toBe("network.body.skipped");
    expect(event?.data).toMatchObject({
      reqId: "2.1",
      side: "response",
      reason: "too-large",
      mimeType: "text/javascript",
      size: 5_000_000,
      limit: BODY_LIMIT_BYTES
    });
    expect((event?.data as { detail: string }).detail.length).toBeLessThanOrEqual(200);
    expect((event?.data as Record<string, unknown>).extra).toBeUndefined();
  });

  it("drops skip records without a request id or with an unknown reason", () => {
    const recorder = createRecorder();

    expect(
      recorder.ingest(raw("cdp.network.body.skipped", { reason: "empty" }, "system")).event
    ).toBeUndefined();
    expect(
      recorder.ingest(raw("cdp.network.body.skipped", { reqId: "2.2", reason: "?" }, "system"))
        .event
    ).toBeUndefined();
  });
});

describe("browser-internal network filter", () => {
  it("drops every event of an extension request and keeps the app's", () => {
    const recorder = createRecorder();
    const kept: string[] = [];
    const ingest = (event: RawRecorderEvent): void => {
      const result = recorder.ingest(event).event;

      if (result) {
        kept.push(`${result.type}:${(result.data as { requestId?: string }).requestId ?? ""}`);
      }
    };

    ingest(requestWillBeSent("3.1", "chrome-extension://abcdefghijklmnop/content-agent.js"));
    ingest(
      raw("Network.responseReceived", {
        requestId: "3.1",
        response: { url: "chrome-extension://abcdefghijklmnop/content-agent.js", status: 200 }
      })
    );
    ingest(raw("Network.loadingFinished", { requestId: "3.1", encodedDataLength: 1_000_000 }));
    ingest(requestWillBeSent("3.2", "https://app.example/api/items"));
    ingest(raw("Network.loadingFinished", { requestId: "3.2", encodedDataLength: 10 }));
    // Host records arriving after the request ended are dropped too.
    ingest(
      raw(
        "cdp.network.body.skipped",
        { reqId: "3.1", side: "response", reason: "fetch-failed" },
        "system"
      )
    );

    expect(kept).toEqual(["network.request:3.2", "network.finished:3.2"]);
  });

  it("drops a response of an extension URL seen without its request", () => {
    const { event } = createRecorder().ingest(
      raw("Network.responseReceived", {
        requestId: "4.1",
        response: { url: "moz-extension://id/script.js", status: 200 }
      })
    );

    expect(event).toBeUndefined();
  });
});
