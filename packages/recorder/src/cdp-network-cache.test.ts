import { describe, expect, it } from "vitest";

import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  type RecorderConfig
} from "@webblackbox/protocol";

import { MAX_TRACKED_CACHED_REQUESTS } from "./cdp-network.js";
import { WebBlackboxRecorder } from "./recorder.js";

const IMAGE_URL = "https://cdn.example.com/lobby/game-217.jpg";
const DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const BLOB_URL = "blob:https://app.example.com/185f764e-1a7b-4c1d-9e0f-2a3b4c5d6e7f";

type CdpStep = { method: string; params: Record<string, unknown>; sessionId?: string };

function createConfig(): RecorderConfig {
  return { ...DEFAULT_RECORDER_CONFIG, mode: "full", capturePolicy: DEFAULT_CAPTURE_POLICY };
}

/** Feeds CDP events through one recorder and returns the stored events, in order. */
function record(steps: CdpStep[]): Array<{ type: string; data: Record<string, unknown> }> {
  const recorder = new WebBlackboxRecorder(createConfig());

  return steps.flatMap((step, index) => {
    const event = recorder.ingest({
      source: "cdp",
      rawType: step.method,
      sid: "S-cdp-cache",
      tabId: 1,
      t: 1_700_000_000_000 + index,
      mono: 10 + index,
      cdpSessionId: step.sessionId,
      payload: step.params
    }).event;

    return event ? [{ type: event.type, data: event.data as Record<string, unknown> }] : [];
  });
}

function requestWillBeSent(requestId: string, url: string): CdpStep {
  return {
    method: "Network.requestWillBeSent",
    params: {
      requestId,
      loaderId: "L1",
      frameId: "F1",
      timestamp: 613_816.6,
      wallTime: 1_791_201_437.3,
      type: "Image",
      initiator: { type: "parser" },
      request: { url, method: "GET", headers: {}, initialPriority: "Low" }
    }
  };
}

function responseReceived(
  requestId: string,
  url: string,
  response: Record<string, unknown> = {}
): CdpStep {
  return {
    method: "Network.responseReceived",
    params: {
      requestId,
      loaderId: "L1",
      frameId: "F1",
      timestamp: 613_816.7,
      type: "Image",
      hasExtraInfo: false,
      response: {
        url,
        status: 200,
        statusText: "OK",
        headers: { "content-type": "image/jpeg" },
        mimeType: "image/jpeg",
        connectionReused: false,
        fromDiskCache: false,
        fromServiceWorker: false,
        fromPrefetchCache: false,
        encodedDataLength: 266,
        ...response
      }
    }
  };
}

function servedFromCache(requestId: string, sessionId?: string): CdpStep {
  return { method: "Network.requestServedFromCache", params: { requestId }, sessionId };
}

function loadingFinished(requestId: string, encodedDataLength = 0, sessionId?: string): CdpStep {
  return {
    method: "Network.loadingFinished",
    params: { requestId, timestamp: 613_816.8, encodedDataLength },
    sessionId
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

describe("CDP requests served from cache", () => {
  it("marks a memory-cache hit on its response and finish (Chrome's event order)", () => {
    const events = record([
      requestWillBeSent("90080.1423", IMAGE_URL),
      servedFromCache("90080.1423"),
      responseReceived("90080.1423", IMAGE_URL),
      loadingFinished("90080.1423")
    ]);

    expect(events.map((event) => event.type)).toEqual([
      "network.request",
      "network.response",
      "network.finished"
    ]);
    expect(events[1]?.data.response).toMatchObject({
      status: 200,
      fromDiskCache: false,
      fromMemoryCache: true
    });
    expect(events[2]?.data).toMatchObject({ requestId: "90080.1423", fromMemoryCache: true });
  });

  it("closes a cached request that never gets responseReceived", () => {
    const events = record([
      requestWillBeSent("r-1", IMAGE_URL),
      servedFromCache("r-1"),
      loadingFinished("r-1")
    ]);

    expect(events.map((event) => event.type)).toEqual(["network.request", "network.finished"]);
    expect(events[1]?.data).toMatchObject({ requestId: "r-1", fromMemoryCache: true });
  });

  it("does not mark disk-cache or network responses as memory cache", () => {
    const events = record([
      requestWillBeSent("disk", IMAGE_URL),
      responseReceived("disk", IMAGE_URL, { fromDiskCache: true }),
      loadingFinished("disk", 0),
      requestWillBeSent("net", IMAGE_URL),
      responseReceived("net", IMAGE_URL),
      loadingFinished("net", 5_120)
    ]);

    for (const event of events) {
      expect(event.data.fromMemoryCache).toBeUndefined();
      expect(asRecord(event.data.response)?.fromMemoryCache).toBeUndefined();
    }

    expect(asRecord(events[1]?.data.response)?.fromDiskCache).toBe(true);
    expect(events[5]?.data.encodedDataLength).toBe(5_120);
  });

  it("marks data: images, which Chrome serves from the memory cache", () => {
    const events = record([
      requestWillBeSent("d-1", DATA_URL),
      servedFromCache("d-1"),
      responseReceived("d-1", DATA_URL, { encodedDataLength: 0, mimeType: "image/png" }),
      loadingFinished("d-1")
    ]);

    expect(asRecord(events[1]?.data.response)?.fromMemoryCache).toBe(true);
    expect(events[2]?.data.fromMemoryCache).toBe(true);
  });

  it("drops the unknown (-1) encoded length Chrome reports for blob: URLs", () => {
    const events = record([
      requestWillBeSent("b-1", BLOB_URL),
      responseReceived("b-1", BLOB_URL, { encodedDataLength: -1 }),
      loadingFinished("b-1", -1)
    ]);

    expect(asRecord(events[1]?.data.response)?.encodedDataLength).toBeUndefined();
    expect(events[2]?.data.encodedDataLength).toBeUndefined();
    expect(events[2]?.data.fromMemoryCache).toBeUndefined();
  });

  it("keeps cache marks apart per CDP session", () => {
    const events = record([
      servedFromCache("same-id", "child-session"),
      loadingFinished("same-id", 0, "root-session"),
      loadingFinished("same-id", 0, "child-session")
    ]);

    expect(events.map((event) => event.data.fromMemoryCache)).toEqual([undefined, true]);
  });

  it("forgets the oldest cache marks beyond the tracking bound", () => {
    const steps = Array.from({ length: MAX_TRACKED_CACHED_REQUESTS + 1 }, (_, index) =>
      servedFromCache(`img-${index}`)
    );
    const events = record([
      ...steps,
      loadingFinished("img-0"),
      loadingFinished(`img-${MAX_TRACKED_CACHED_REQUESTS}`)
    ]);

    expect(events.map((event) => event.data.fromMemoryCache)).toEqual([undefined, true]);
  });
});
