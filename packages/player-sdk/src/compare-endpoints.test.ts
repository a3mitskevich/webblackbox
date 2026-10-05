import { describe, expect, it } from "vitest";

import {
  alignEndpoints,
  endpointKey,
  summarizeEndpoints,
  type CompareRequest
} from "./compare-endpoints.js";

function request(
  reqId: string,
  url: string,
  startMono: number,
  durationMs: number,
  extra: Partial<CompareRequest> = {}
): CompareRequest {
  return { reqId, method: "get", url, startMono, durationMs, failed: false, status: 200, ...extra };
}

const API = "https://app.example.test/api";

describe("summarizeEndpoints", () => {
  it("groups by method, host and path and reads count, failures and p95", () => {
    const summary = summarizeEndpoints([
      request("1", `${API}/users?id=1`, 30, 100),
      request("2", `${API}/users?id=2`, 10, 300, { status: 401, responseBodyHash: "h2" }),
      request("3", `${API}/users`, 20, 200, { responseBodyHash: "h3" }),
      request("4", "relative/path?x=1", 40, 5, { method: "POST", failed: true })
    ]);

    expect(summary.get("GET app.example.test/api/users")).toEqual({
      key: "GET app.example.test/api/users",
      method: "GET",
      path: "app.example.test/api/users",
      count: 3,
      failureCount: 1,
      p95Ms: 300,
      firstStartMono: 10,
      firstReqId: "2",
      firstBodyReqId: "2"
    });
    expect(summary.get("POST relative/path")?.failureCount).toBe(1);
    expect(endpointKey({ method: "put", url: "blob:x" })).toBe("PUT x");
  });
});

describe("alignEndpoints", () => {
  it("pairs endpoints and labels new, missing, regressed, slower and stable ones", () => {
    const left = [
      request("a1", `${API}/config`, 1_000, 50),
      request("a2", `${API}/users`, 1_100, 100),
      request("a3", `${API}/slow`, 1_200, 100),
      request("a4", `${API}/gone`, 1_300, 10)
    ];
    const right = [
      request("b1", `${API}/config`, 5_000, 60),
      request("b2", `${API}/users`, 5_100, 90, { status: 401 }),
      request("b3", `${API}/slow`, 5_200, 400),
      request("b4", `${API}/fresh`, 5_250, 10)
    ];

    expect(
      alignEndpoints(left, right).map((row) => [row.key.split("/").pop(), row.signal])
    ).toEqual([
      ["config", "stable"],
      ["users", "regressed"],
      ["slow", "slower"],
      ["fresh", "new"],
      ["gone", "missing"]
    ]);
  });

  it("handles empty sessions", () => {
    expect(alignEndpoints([], [])).toEqual([]);
    expect(alignEndpoints([], [request("x", `${API}/x`, 1, 1)])[0]?.signal).toBe("new");
  });
});
