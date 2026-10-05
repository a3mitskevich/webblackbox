import { describe, expect, it } from "vitest";

import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  type CapturePolicy,
  type RecorderConfig
} from "@webblackbox/protocol";

import type { InlineNetworkBodyContext } from "./network-body-policy.js";
import { WebBlackboxRecorder } from "./recorder.js";
import type { RawRecorderEvent } from "./types.js";

const LOGIN_FORM = "username=bob&password=hunter2";
const LOGIN_FORM_BASE64 = Buffer.from(LOGIN_FORM, "utf8").toString("base64");
const LOGIN_JSON = '{"username":"bob","password":"hunter2"}';
const WS_AUTH_FRAME = '{"type":"auth","token":"s3cr3t-token-value","msg":"hello"}';

type NetworkPolicy = CapturePolicy["categories"]["network"];

function createConfig(network: NetworkPolicy): RecorderConfig {
  return {
    ...DEFAULT_RECORDER_CONFIG,
    mode: "full",
    capturePolicy: {
      ...DEFAULT_CAPTURE_POLICY,
      categories: {
        ...DEFAULT_CAPTURE_POLICY.categories,
        network
      }
    }
  };
}

function ingestCdp(
  network: NetworkPolicy,
  rawType: string,
  payload: unknown,
  shouldKeepInlineNetworkBody?: (context: InlineNetworkBodyContext) => boolean
) {
  const recorder = new WebBlackboxRecorder(createConfig(network), { shouldKeepInlineNetworkBody });
  const raw: RawRecorderEvent = {
    source: "cdp",
    rawType,
    sid: "S-cdp-network",
    tabId: 1,
    t: 1_700_000_000_000,
    mono: 10,
    cdpSessionId: "cdp-session-1",
    payload
  };
  const event = recorder.ingest(raw).event;

  expect(event).toBeDefined();
  return event!;
}

function ingestContent(network: NetworkPolicy, rawType: string, payload: unknown) {
  const recorder = new WebBlackboxRecorder(createConfig(network));
  const event = recorder.ingest({
    source: "content",
    rawType,
    sid: "S-content-network",
    tabId: 1,
    t: 1_700_000_000_000,
    mono: 10,
    payload
  }).event;

  expect(event).toBeDefined();
  return event!;
}

function createRequestWillBeSent(
  overrides: { headers?: Record<string, string>; postData?: string; entries?: string[] } = {}
): Record<string, unknown> {
  const postData = overrides.postData ?? LOGIN_FORM;
  const entries = overrides.entries ?? [Buffer.from(postData, "utf8").toString("base64")];

  return {
    requestId: "1000.42",
    loaderId: "LOADER-1",
    documentURL: "https://app.example.com/login?next=%2Fhome&code=OAUTH123",
    request: {
      url: "https://app.example.com/api/session?code=OAUTH123",
      urlFragment: "#access_token=fragment-secret",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Bearer header-secret",
        Accept: "application/json",
        ...overrides.headers
      },
      postData,
      hasPostData: true,
      postDataEntries: entries.map((bytes) => ({ bytes })),
      mixedContentType: "none",
      initialPriority: "High",
      referrerPolicy: "strict-origin-when-cross-origin",
      isSameSite: true,
      trustTokenParams: { operation: "Redemption", refreshPolicy: "UseCached" }
    },
    timestamp: 5123.25,
    wallTime: 1_700_000_000.5,
    initiator: {
      type: "script",
      stack: {
        callFrames: [
          {
            functionName: "submitLoginForm",
            scriptId: "77",
            url: "https://app.example.com/app.js?token=script-secret",
            lineNumber: 10,
            columnNumber: 4
          }
        ]
      }
    },
    redirectHasExtraInfo: false,
    type: "XHR",
    frameId: "FRAME-1",
    hasUserGesture: true
  };
}

describe("CDP Network allowlist", () => {
  describe("Network.requestWillBeSent", () => {
    it("drops postData and base64 postDataEntries under the metadata policy", () => {
      const event = ingestCdp("metadata", "Network.requestWillBeSent", createRequestWillBeSent());
      const data = event.data as {
        requestId?: string;
        postDataSize?: number;
        type?: string;
        initiator?: Record<string, unknown>;
        request?: Record<string, unknown>;
      };
      const serialized = JSON.stringify(data);

      expect(event.type).toBe("network.request");
      expect(serialized).not.toContain("hunter2");
      expect(serialized).not.toContain(LOGIN_FORM_BASE64);
      expect(serialized).not.toContain("postDataEntries");
      expect(serialized).not.toContain('"postData"');
      expect(data.request?.postData).toBeUndefined();
      expect(data.request?.hasPostData).toBe(true);
      expect(data.postDataSize).toBe(LOGIN_FORM.length);
      expect(data.requestId).toBe("1000.42");
      expect(data.type).toBe("XHR");
      expect(data.request?.method).toBe("POST");
      expect(data.request?.url).toBe("https://app.example.com/api/session");
      expect(data.initiator).toEqual({ type: "script" });
    });

    it("drops fields outside the allowlist", () => {
      const event = ingestCdp("metadata", "Network.requestWillBeSent", createRequestWillBeSent());
      const serialized = JSON.stringify(event.data);

      expect(serialized).not.toContain("fragment-secret");
      expect(serialized).not.toContain("trustTokenParams");
      expect(serialized).not.toContain("submitLoginForm");
      expect(serialized).not.toContain("script-secret");
      expect(serialized).not.toContain("OAUTH123");
      expect(serialized).not.toContain("header-secret");
    });

    it("keeps request headers, normalized and redacted", () => {
      const event = ingestCdp("metadata", "Network.requestWillBeSent", createRequestWillBeSent());
      const headers = (event.data as { request?: { headers?: Record<string, string> } }).request
        ?.headers;

      expect(headers?.["content-type"]).toBe("application/x-www-form-urlencoded");
      expect(headers?.accept).toBe("application/json");
      expect(headers?.authorization).toBeDefined();
      expect(headers?.authorization).not.toContain("header-secret");
    });

    it("keeps a value-masked form body under body-allowlist", () => {
      const event = ingestCdp(
        "body-allowlist",
        "Network.requestWillBeSent",
        createRequestWillBeSent()
      );
      const data = event.data as { postDataSize?: number; request?: Record<string, unknown> };
      const serialized = JSON.stringify(data);

      expect(data.request?.postData).toBe("username=bob&password=[REDACTED]");
      expect(data.postDataSize).toBe(LOGIN_FORM.length);
      expect(serialized).not.toContain("hunter2");
      expect(serialized).not.toContain(LOGIN_FORM_BASE64);
      expect(serialized).not.toContain("postDataEntries");
    });

    it("lets the host gate drop the body under body-allowlist, keeping only its size", () => {
      const contexts: InlineNetworkBodyContext[] = [];
      const event = ingestCdp(
        "body-allowlist",
        "Network.requestWillBeSent",
        createRequestWillBeSent(),
        (context) => {
          contexts.push(context);
          return false;
        }
      );
      const data = event.data as { postDataSize?: number; request?: Record<string, unknown> };

      expect(contexts).toEqual([
        {
          eventType: "network.request",
          url: "https://app.example.com/api/session?code=OAUTH123",
          mimeType: "application/x-www-form-urlencoded"
        }
      ]);
      expect(data.request?.postData).toBeUndefined();
      expect(data.request?.hasPostData).toBe(true);
      expect(data.postDataSize).toBe(LOGIN_FORM.length);
      expect(JSON.stringify(data)).not.toContain("hunter2");
    });

    it("does not consult the host gate when the policy already drops the body", () => {
      let calls = 0;
      const event = ingestCdp(
        "metadata",
        "Network.requestWillBeSent",
        createRequestWillBeSent(),
        () => {
          calls += 1;
          return true;
        }
      );

      expect(calls).toBe(0);
      expect(
        (event.data as { request?: Record<string, unknown> }).request?.postData
      ).toBeUndefined();
    });

    it("decodes base64 postDataEntries when postData is absent", () => {
      const payload = createRequestWillBeSent({
        headers: { "Content-Type": "application/json" },
        postData: LOGIN_JSON
      });
      const request = (payload.request as Record<string, unknown>) ?? {};
      const withoutPostData = { ...payload, request: { ...request, postData: undefined } };

      const event = ingestCdp("body-allowlist", "Network.requestWillBeSent", withoutPostData);
      const data = event.data as { postDataSize?: number; request?: Record<string, unknown> };

      expect(data.request?.postData).toBe('{"username":"bob","password":"[REDACTED]"}');
      expect(data.postDataSize).toBe(LOGIN_JSON.length);
      expect(JSON.stringify(data)).not.toContain("hunter2");
    });

    it("joins multi-entry postDataEntries before masking", () => {
      const event = ingestCdp(
        "body-allowlist",
        "Network.requestWillBeSent",
        createRequestWillBeSent({
          entries: [
            Buffer.from("username=bob&pass", "utf8").toString("base64"),
            Buffer.from("word=hunter2", "utf8").toString("base64")
          ]
        })
      );
      const data = event.data as { request?: Record<string, unknown> };

      expect(data.request?.postData).toBe("username=bob&password=[REDACTED]");
    });

    it("does not inline non-textual bodies even under body-allowlist", () => {
      const multipart =
        '--boundary\r\nContent-Disposition: form-data; name="password"\r\n\r\nhunter2\r\n--boundary--';
      const event = ingestCdp(
        "body-allowlist",
        "Network.requestWillBeSent",
        createRequestWillBeSent({
          headers: { "Content-Type": "multipart/form-data; boundary=boundary" },
          postData: multipart
        })
      );
      const data = event.data as { postDataSize?: number; request?: Record<string, unknown> };

      expect(data.request?.postData).toBeUndefined();
      expect(data.request?.hasPostData).toBe(true);
      expect(data.postDataSize).toBe(multipart.length);
      expect(JSON.stringify(data)).not.toContain("hunter2");
    });

    it("caps inline request bodies", () => {
      const largeBody = `password=hunter2&filler=${"x".repeat(80_000)}`;
      const event = ingestCdp(
        "body-allowlist",
        "Network.requestWillBeSent",
        createRequestWillBeSent({ postData: largeBody })
      );
      const data = event.data as { postDataSize?: number; request?: Record<string, unknown> };
      const postData = data.request?.postData as string;

      expect(postData.startsWith("password=[REDACTED]&filler=")).toBe(true);
      expect(postData.length).toBeLessThanOrEqual(64 * 1024);
      expect(data.request?.postDataTruncated).toBe(true);
      expect(data.postDataSize).toBe(largeBody.length);
    });

    it("keeps the allowlisted redirect response", () => {
      const event = ingestCdp("metadata", "Network.requestWillBeSent", {
        ...createRequestWillBeSent(),
        redirectResponse: {
          url: "https://app.example.com/old?code=OAUTH123",
          status: 302,
          statusText: "Found",
          headers: { Location: "https://app.example.com/new?code=OAUTH123" },
          headersText: "HTTP/1.1 302 Found\r\nSet-Cookie: session=raw-cookie\r\n",
          mimeType: "text/html"
        }
      });
      const redirect = (event.data as { redirectResponse?: Record<string, unknown> })
        .redirectResponse;

      expect(redirect?.status).toBe(302);
      expect(redirect?.url).toBe("https://app.example.com/old");
      expect(JSON.stringify(redirect)).not.toContain("raw-cookie");
      expect(JSON.stringify(redirect)).not.toContain("OAUTH123");
    });
  });

  describe("Network.responseReceived", () => {
    it("keeps status, mime, sizes and timing but drops raw header text and security details", () => {
      const event = ingestCdp("metadata", "Network.responseReceived", {
        requestId: "1000.42",
        loaderId: "LOADER-1",
        timestamp: 5124.5,
        type: "XHR",
        frameId: "FRAME-1",
        hasExtraInfo: true,
        response: {
          url: "https://app.example.com/api/session",
          status: 200,
          statusText: "OK",
          headers: { "Content-Type": "application/json", "Set-Cookie": "session=raw-cookie" },
          headersText: "HTTP/1.1 200 OK\r\nSet-Cookie: session=raw-cookie\r\n",
          mimeType: "application/json",
          charset: "utf-8",
          requestHeaders: { Cookie: "session=raw-cookie" },
          requestHeadersText: "POST /api/session HTTP/1.1\r\nCookie: session=raw-cookie\r\n",
          connectionReused: true,
          connectionId: 31,
          remoteIPAddress: "10.0.0.1",
          remotePort: 443,
          fromDiskCache: false,
          fromServiceWorker: false,
          fromPrefetchCache: false,
          encodedDataLength: 321,
          timing: {
            requestTime: 5123.3,
            proxyStart: -1,
            dnsStart: 0.1,
            connectStart: 0.2,
            sendStart: 1.5,
            receiveHeadersEnd: 12.75
          },
          responseTime: 1_700_000_000_123,
          protocol: "h2",
          securityState: "secure",
          securityDetails: { subjectName: "app.example.com", issuer: "Example CA" }
        }
      });
      const data = event.data as { requestId?: string; response?: Record<string, unknown> };
      const serialized = JSON.stringify(data);

      expect(event.type).toBe("network.response");
      expect(data.requestId).toBe("1000.42");
      expect(data.response?.status).toBe(200);
      expect(data.response?.mimeType).toBe("application/json");
      expect(data.response?.encodedDataLength).toBe(321);
      expect(data.response?.protocol).toBe("h2");
      expect(data.response?.timing).toEqual({
        requestTime: 5123.3,
        proxyStart: -1,
        dnsStart: 0.1,
        connectStart: 0.2,
        sendStart: 1.5,
        receiveHeadersEnd: 12.75
      });
      expect((data.response?.headers as Record<string, string>)["content-type"]).toBe(
        "application/json"
      );
      expect(serialized).not.toContain("raw-cookie");
      expect(serialized).not.toContain("headersText");
      expect(serialized).not.toContain("requestHeaders");
      expect(serialized).not.toContain("securityDetails");
      expect(serialized).not.toContain("10.0.0.1");
    });
  });

  describe("Network.loadingFinished / loadingFailed", () => {
    it("keeps sizes and error details", () => {
      const finished = ingestCdp("metadata", "Network.loadingFinished", {
        requestId: "1000.42",
        timestamp: 5125,
        encodedDataLength: 654
      });
      const failed = ingestCdp("metadata", "Network.loadingFailed", {
        requestId: "1000.43",
        timestamp: 5126,
        type: "Fetch",
        errorText: "net::ERR_FAILED",
        canceled: false,
        corsErrorStatus: { corsError: "MissingAllowOriginHeader", failedParameter: "" }
      });

      expect(finished.data).toEqual({
        requestId: "1000.42",
        timestamp: 5125,
        encodedDataLength: 654
      });
      expect(failed.data).toEqual({
        requestId: "1000.43",
        timestamp: 5126,
        type: "Fetch",
        errorText: "net::ERR_FAILED",
        canceled: false,
        corsErrorStatus: { corsError: "MissingAllowOriginHeader" }
      });
    });
  });

  describe("WebSocket frames", () => {
    const sentFrame = {
      requestId: "ws-1",
      timestamp: 5130,
      response: { opcode: 1, mask: true, payloadData: WS_AUTH_FRAME }
    };

    it("keeps only opcode and length under the metadata policy", () => {
      const event = ingestCdp("metadata", "Network.webSocketFrameSent", sentFrame);
      const data = event.data as { requestId?: string; direction?: string; frame?: unknown };
      const serialized = JSON.stringify(data);

      expect(event.type).toBe("network.ws.frame");
      expect(data.requestId).toBe("ws-1");
      expect(data.direction).toBe("sent");
      expect(data.frame).toEqual({
        opcode: 1,
        masked: true,
        payloadLength: WS_AUTH_FRAME.length
      });
      expect(serialized).not.toContain("payloadData");
      expect(serialized).not.toContain("s3cr3t");
      expect(serialized).not.toContain("hello");
    });

    it("keeps a value-masked, capped preview under body-allowlist", () => {
      const event = ingestCdp("body-allowlist", "Network.webSocketFrameReceived", {
        ...sentFrame,
        response: { ...sentFrame.response, mask: false }
      });
      const data = event.data as { direction?: string; frame?: Record<string, unknown> };
      const serialized = JSON.stringify(data);

      expect(data.direction).toBe("received");
      expect(data.frame?.payloadPreview).toBe('{"type":"auth","token":"[REDACTED]","msg":"hello"}');
      expect(data.frame?.payloadLength).toBe(WS_AUTH_FRAME.length);
      expect(serialized).not.toContain("payloadData");
      expect(serialized).not.toContain("s3cr3t");
    });

    it("caps long text frames", () => {
      const longFrame = `password=hunter2 ${"y".repeat(4_000)}`;
      const event = ingestCdp("body-allowlist", "Network.webSocketFrameReceived", {
        requestId: "ws-1",
        timestamp: 5131,
        response: { opcode: 1, mask: false, payloadData: longFrame }
      });
      const frame = (event.data as { frame?: Record<string, unknown> }).frame;
      const preview = frame?.payloadPreview as string;

      expect(preview.startsWith("password=[REDACTED] ")).toBe(true);
      expect(preview.length).toBeLessThanOrEqual(512);
      expect(frame?.payloadTruncated).toBe(true);
      expect(frame?.payloadLength).toBe(longFrame.length);
    });

    it("never previews binary frames", () => {
      const binary = Buffer.from("password=hunter2", "utf8").toString("base64");
      const event = ingestCdp("body-allowlist", "Network.webSocketFrameReceived", {
        requestId: "ws-1",
        timestamp: 5132,
        response: { opcode: 2, mask: false, payloadData: binary }
      });
      const data = event.data as { frame?: Record<string, unknown> };

      expect(data.frame).toEqual({ opcode: 2, masked: false, payloadLength: binary.length });
      expect(JSON.stringify(data)).not.toContain(binary);
    });

    it("sanitizes the socket url on open and drops close noise", () => {
      const opened = ingestCdp("metadata", "Network.webSocketCreated", {
        requestId: "ws-1",
        url: "wss://app.example.com/socket?token=ws-secret",
        initiator: { type: "script", stack: { callFrames: [{ functionName: "connectSocket" }] } }
      });
      const closed = ingestCdp("metadata", "Network.webSocketClosed", {
        requestId: "ws-1",
        timestamp: 5140
      });

      expect(JSON.stringify(opened.data)).not.toContain("ws-secret");
      expect(JSON.stringify(opened.data)).not.toContain("connectSocket");
      expect((opened.data as { initiator?: unknown }).initiator).toEqual({ type: "script" });
      expect(closed.data).toEqual({ requestId: "ws-1", timestamp: 5140 });
    });
  });

  describe("SSE messages", () => {
    it("drops message data under the metadata policy", () => {
      const event = ingestContent("metadata", "sse", {
        phase: "message",
        url: "https://app.example.com/stream",
        streamId: "sse-1",
        requestId: "sse-1",
        eventType: "message",
        data: "token=sse-secret"
      });
      const data = event.data as Record<string, unknown>;

      expect(event.type).toBe("network.sse.message");
      expect(data.data).toBeUndefined();
      expect(data.dataRedacted).toBe(true);
      expect(data.dataSize).toBe("token=sse-secret".length);
      expect(JSON.stringify(data)).not.toContain("sse-secret");
    });

    it("keeps value-masked message data under body-allowlist", () => {
      const event = ingestContent("body-allowlist", "sse", {
        phase: "message",
        url: "https://app.example.com/stream",
        streamId: "sse-1",
        requestId: "sse-1",
        eventType: "message",
        data: '{"token":"sse-secret","n":1}'
      });
      const data = event.data as Record<string, unknown>;

      expect(data.data).toBe('{"token":"[REDACTED]","n":1}');
      expect(data.dataSize).toBeUndefined();
    });
  });
});
