import { describe, expect, it } from "vitest";

import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  type CapturePolicy,
  type RecorderConfig
} from "@webblackbox/protocol";

import { WebBlackboxRecorder } from "./recorder.js";

const FULL_CAPTURE_BODY_BYTES = 128 * 1024;
const SIGNALR_SEPARATOR = "\u001e";

type NetworkPolicy = CapturePolicy["categories"]["network"];

function createConfig(network: NetworkPolicy, bodyCaptureMaxBytes: number): RecorderConfig {
  return {
    ...DEFAULT_RECORDER_CONFIG,
    mode: "full",
    sampling: { ...DEFAULT_RECORDER_CONFIG.sampling, bodyCaptureMaxBytes },
    capturePolicy: {
      ...DEFAULT_CAPTURE_POLICY,
      categories: { ...DEFAULT_CAPTURE_POLICY.categories, network }
    }
  };
}

function ingest(
  network: NetworkPolicy,
  rawType: string,
  payload: unknown,
  bodyCaptureMaxBytes = FULL_CAPTURE_BODY_BYTES
): { type: string; data: Record<string, unknown> } {
  const recorder = new WebBlackboxRecorder(createConfig(network, bodyCaptureMaxBytes));
  const event = recorder.ingest({
    source: "cdp",
    rawType,
    sid: "S-body-fidelity",
    tabId: 1,
    t: 1_700_000_000_000,
    mono: 10,
    payload
  }).event;

  expect(event).toBeDefined();
  return { type: event!.type, data: event!.data as Record<string, unknown> };
}

/** A SignalR invocation result like the ones the lobby socket streams (~10 KB). */
function createSignalRFrame(games: number): string {
  const message = {
    type: 3,
    invocationId: "0",
    result: {
      data: Array.from({ length: games }, (_, index) => ({
        gameId: 90_000_467_807 + index,
        gameEdition: `KN59${index}`,
        gameType: 9,
        currentRoundId: 1,
        gameTimeState: 4,
        bettingTimeInMs: 0,
        isBlur: false,
        startAfterInSec: 0,
        totalBettingTimeInSec: 170
      }))
    }
  };

  return `${JSON.stringify(message)}${SIGNALR_SEPARATOR}`;
}

function frameReceived(payloadData: string): Record<string, unknown> {
  return {
    requestId: "90080.1659",
    timestamp: 613_817.1,
    response: { opcode: 1, mask: false, payloadData }
  };
}

function ingestFrame(
  network: NetworkPolicy,
  payloadData: string,
  bodyCaptureMaxBytes?: number
): Record<string, unknown> {
  const { data } = ingest(
    network,
    "Network.webSocketFrameReceived",
    frameReceived(payloadData),
    bodyCaptureMaxBytes
  );
  return data.frame as Record<string, unknown>;
}

describe("WebSocket frames under body-allowlist", () => {
  it("keeps a 10 KB SignalR frame whole", () => {
    const payload = createSignalRFrame(60);
    const frame = ingestFrame("body-allowlist", payload);

    expect(payload.length).toBeGreaterThan(10_000);
    expect(frame.payloadPreview).toBe(payload);
    expect(frame.payloadTruncated).toBeUndefined();
    expect(frame.payloadLength).toBe(payload.length);
  });

  it("cuts frames at the profile body limit in UTF-8 bytes and flags them", () => {
    // 3-byte characters: the cut must land on a character boundary within the byte budget.
    const payload = `{"text":"${"€".repeat(60_000)}"}`;
    const frame = ingestFrame("body-allowlist", payload);
    const kept = frame.payloadPreview as string;
    const keptBytes = new TextEncoder().encode(kept).byteLength;

    expect(frame.payloadTruncated).toBe(true);
    expect(keptBytes).toBeLessThanOrEqual(FULL_CAPTURE_BODY_BYTES);
    expect(keptBytes).toBeGreaterThan(FULL_CAPTURE_BODY_BYTES - 3);
    expect(payload.startsWith(kept)).toBe(true);
  });

  it("still masks sensitive values in long frames", () => {
    const payload = `${createSignalRFrame(40)}{"password":"hunter2"}${SIGNALR_SEPARATOR}`;
    const frame = ingestFrame("body-allowlist", payload);

    expect(frame.payloadPreview).toContain('"password":"[REDACTED]"');
    expect(JSON.stringify(frame)).not.toContain("hunter2");
  });

  it("falls back to the 512-char preview when the profile captures no bodies", () => {
    const frame = ingestFrame("body-allowlist", createSignalRFrame(60), 0);

    expect((frame.payloadPreview as string).length).toBe(512);
    expect(frame.payloadTruncated).toBe(true);
  });

  it("keeps only length and opcode under the metadata policy", () => {
    const payload = createSignalRFrame(60);

    expect(ingestFrame("metadata", payload)).toEqual({
      opcode: 1,
      masked: false,
      payloadLength: payload.length
    });
  });
});

describe("CDP EventSource messages", () => {
  const message = {
    requestId: "sse-77",
    timestamp: 613_820.5,
    eventName: "odds",
    eventId: "e-42",
    data: JSON.stringify({ odds: Array.from({ length: 900 }, (_, index) => index / 7) })
  };

  it("records Network.eventSourceMessageReceived as a full SSE message", () => {
    const { type, data } = ingest("body-allowlist", "Network.eventSourceMessageReceived", message);

    expect(message.data.length).toBeGreaterThan(10_000);
    expect(type).toBe("network.sse.message");
    expect(data).toMatchObject({
      requestId: "sse-77",
      phase: "message",
      eventType: "odds",
      lastEventId: "e-42",
      data: message.data
    });
    expect(data.dataTruncated).toBeUndefined();
  });

  it("drops the message text under the metadata policy", () => {
    const { data } = ingest("metadata", "Network.eventSourceMessageReceived", message);

    expect(data.data).toBeUndefined();
    expect(data.dataRedacted).toBe(true);
    expect(data.dataSize).toBe(message.data.length);
  });
});
