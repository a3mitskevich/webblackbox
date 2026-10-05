import { describe, expect, it } from "vitest";

import type { RealtimeNetworkEntry } from "./index.js";
import { buildRealtimeStreams, realtimeMessageBytes } from "./realtime-streams.js";

const RS = "\u001e";

let sequence = 0;

function entry(patch: Partial<RealtimeNetworkEntry>): RealtimeNetworkEntry {
  sequence += 1;
  return {
    eventId: `E-${sequence}`,
    eventType: "network.ws.frame",
    protocol: "ws",
    mono: sequence,
    t: sequence,
    ...patch
  };
}

describe("buildRealtimeStreams", () => {
  it("groups a socket's open, frames and close with counts, bytes and cut frames", () => {
    const streams = buildRealtimeStreams([
      entry({ eventType: "network.ws.open", streamId: "s1", url: "wss://a.test/hub", mono: 10 }),
      entry({
        streamId: "s1",
        direction: "sent",
        mono: 11,
        payloadPreview: `{"protocol":"json","version":1}${RS}`,
        payloadLength: 32
      }),
      entry({
        streamId: "s1",
        direction: "received",
        mono: 12,
        payloadPreview: `{"type":1,"target":"GameState","argu`,
        payloadLength: 6_786,
        payloadTruncated: true
      }),
      entry({ eventType: "network.ws.close", streamId: "s1", mono: 20 })
    ]);

    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({
      streamId: "s1",
      protocol: "ws",
      url: "wss://a.test/hub",
      openMono: 10,
      closeMono: 20,
      firstMono: 10,
      lastMono: 20,
      sent: 1,
      received: 1,
      sentBytes: 32,
      receivedBytes: 6_786,
      truncated: 1,
      format: "signalr"
    });
    expect(streams[0]?.messages.map((message) => message.mono)).toEqual([11, 12]);
  });

  it("keeps streams apart, ordered by their first event, and sorts each by time", () => {
    const streams = buildRealtimeStreams([
      entry({ streamId: "late", mono: 50, payloadPreview: "b" }),
      entry({ streamId: "early", mono: 30, payloadPreview: `{"a":2}` }),
      entry({ streamId: "early", mono: 5, payloadPreview: `{"a":1}` })
    ]);

    expect(streams.map((stream) => [stream.streamId, stream.firstMono, stream.format])).toEqual([
      ["early", 5, "json"],
      ["late", 50, "text"]
    ]);
    expect(streams[0]).not.toHaveProperty("openMono");
    expect(streams[0]).not.toHaveProperty("closeMono");
  });

  it("tells SSE streams, mixed and binary formats, and streams without an id", () => {
    const streams = buildRealtimeStreams([
      entry({
        eventType: "network.sse.message",
        protocol: "sse",
        streamId: "r1",
        payloadPreview: `{"price":1}`
      }),
      entry({ streamId: "m", payloadPreview: `{"a":1}` }),
      entry({ streamId: "m", payloadPreview: "plain" }),
      entry({ streamId: "b", opcode: 2, payloadPreview: "AAEC" }),
      entry({ eventType: "network.ws.open", streamId: "quiet" }),
      entry({ payloadPreview: "no id" })
    ]);

    expect(streams.map((stream) => [stream.protocol, stream.streamId, stream.format])).toEqual([
      ["sse", "r1", "json"],
      ["ws", "m", "mixed"],
      ["ws", "b", "binary"],
      ["ws", "quiet", "empty"],
      ["ws", "", "text"]
    ]);
  });
});

describe("realtimeMessageBytes", () => {
  it("prefers the recorded length and falls back to the kept text", () => {
    expect(realtimeMessageBytes(entry({ payloadLength: 99, payloadPreview: "ab" }))).toBe(99);
    expect(realtimeMessageBytes(entry({ payloadPreview: "abc" }))).toBe(3);
    expect(realtimeMessageBytes(entry({}))).toBe(0);
  });
});
