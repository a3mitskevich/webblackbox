import { describe, expect, it } from "vitest";

import type { NetworkWaterfallEntry } from "@webblackbox/player-sdk";

import { formatNetworkSize } from "./network-size.js";
import { describeNetworkStatus, describeNetworkStatusPlain } from "./network-view.js";

function entry(overrides: Partial<NetworkWaterfallEntry>): NetworkWaterfallEntry {
  return {
    reqId: "R-1",
    url: "https://cdn.example.com/lobby/game-217.jpg",
    method: "GET",
    startMono: 0,
    endMono: 2,
    durationMs: 2,
    startWallTime: 0,
    endWallTime: 2,
    failed: false,
    requestHeaders: {},
    responseHeaders: {},
    eventIds: [],
    ...overrides
  };
}

describe("network status labels", () => {
  it("keeps HTTP status first and labels the cache layer in the size column", () => {
    const cached = entry({
      status: 200,
      statusText: "OK",
      fromCache: "memory",
      encodedDataLength: 0
    });

    expect(describeNetworkStatus(cached)).toBe("200 OK");
    expect(formatNetworkSize(cached)).toBe("(memory cache)");
    expect(formatNetworkSize(entry({ status: 200, fromCache: "disk" }))).toBe("(disk cache)");
    expect(formatNetworkSize(entry({ status: 200, fromCache: "service-worker" }))).toBe(
      "(ServiceWorker)"
    );
    expect(formatNetworkSize(entry({ status: 200, encodedDataLength: 2_048 }))).toBe("2.0 KB");
  });

  it("closes a cached request that has no response instead of showing it as pending", () => {
    const servedFromCache = entry({ fromCache: "memory" });

    expect(describeNetworkStatus(servedFromCache)).toBe("(from cache)");
    expect(describeNetworkStatusPlain(servedFromCache)).toBe("From cache");
    expect(describeNetworkStatus(servedFromCache, "zh-CN")).toBe("（来自缓存）");
  });

  it("tells a finished request without a response apart from a pending one", () => {
    expect(describeNetworkStatus(entry({}))).toBe("(no response)");
    expect(describeNetworkStatus(entry({ pending: true }))).toBe("(pending)");
    expect(describeNetworkStatusPlain(entry({ pending: true }))).toBe("Pending");
    expect(describeNetworkStatus(entry({ pending: true, failed: true }))).toBe("Failed");
  });
});
