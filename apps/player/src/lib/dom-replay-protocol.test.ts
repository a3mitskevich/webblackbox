import { describe, expect, it } from "vitest";

import {
  DOM_REPLAY_MAX_REPORTED_URLS,
  parseFrameToPlayerMessage,
  parsePlayerToFrameMessage
} from "./dom-replay-protocol.js";

describe("parsePlayerToFrameMessage", () => {
  it("accepts load and seek messages", () => {
    const blob = new Blob(["a{}"], { type: "text/css" });

    expect(
      parsePlayerToFrameMessage({
        type: "wb-replay/load",
        events: [{ type: 4, timestamp: 1, data: {} }],
        resources: [{ url: "https://a.test/a.css", mime: "text/css", blob }]
      })
    ).toMatchObject({ type: "wb-replay/load" });
    expect(
      parsePlayerToFrameMessage({ type: "wb-replay/seek", timestamp: 5, highlightNodeId: null })
    ).toEqual({ type: "wb-replay/seek", timestamp: 5, highlightNodeId: null });
  });

  it("rejects malformed messages", () => {
    expect(parsePlayerToFrameMessage({ type: "wb-replay/load", events: [{}], resources: [] })).toBe(
      null
    );
    expect(
      parsePlayerToFrameMessage({
        type: "wb-replay/load",
        events: [],
        resources: [{ url: "x", mime: "y", blob: "not a blob" }]
      })
    ).toBeNull();
    expect(parsePlayerToFrameMessage({ type: "wb-replay/seek", timestamp: "5" })).toBeNull();
    expect(parsePlayerToFrameMessage({ type: "other" })).toBeNull();
    expect(parsePlayerToFrameMessage(null)).toBeNull();
  });
});

describe("parseFrameToPlayerMessage", () => {
  it("accepts the frame's replies and caps what it reports", () => {
    expect(parseFrameToPlayerMessage({ type: "wb-replay/ready" })).toEqual({
      type: "wb-replay/ready"
    });
    const loaded = parseFrameToPlayerMessage({
      type: "wb-replay/loaded",
      eventCount: 3,
      resolvedResources: 1,
      unresolvedUrls: [...Array.from({ length: 80 }, (_, index) => `u${index}`), 5]
    });
    expect(loaded?.type === "wb-replay/loaded" && loaded.unresolvedUrls).toHaveLength(
      DOM_REPLAY_MAX_REPORTED_URLS
    );
    expect(
      parseFrameToPlayerMessage({
        type: "wb-replay/highlight",
        nodeId: 4,
        found: true,
        tagName: "BUTTON",
        rect: { x: 1, y: 2, width: 3, height: 4 }
      })
    ).toEqual({
      type: "wb-replay/highlight",
      nodeId: 4,
      found: true,
      tagName: "BUTTON",
      rect: { x: 1, y: 2, width: 3, height: 4 }
    });
    expect(
      parseFrameToPlayerMessage({ type: "wb-replay/error", message: "x".repeat(2_000) })
    ).toEqual({ type: "wb-replay/error", message: "x".repeat(500) });
  });

  it("rejects anything else", () => {
    expect(parseFrameToPlayerMessage({ type: "wb-replay/highlight", nodeId: "4" })).toBeNull();
    expect(parseFrameToPlayerMessage({ type: "wb-replay/loaded" })).toBeNull();
    expect(parseFrameToPlayerMessage("wb-replay/ready")).toBeNull();
  });
});
