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
  it("groups by method and path and reads count, failures and p95", () => {
    const summary = summarizeEndpoints([
      request("1", `${API}/users?id=1`, 30, 100),
      request("2", `${API}/users?id=2`, 10, 300, { status: 401, responseBodyHash: "h2" }),
      request("3", `${API}/users`, 20, 200, { responseBodyHash: "h3" }),
      request("4", "relative/path?x=1", 40, 5, { method: "POST", failed: true })
    ]);

    expect(summary.get("GET /api/users")).toEqual({
      key: "GET /api/users",
      method: "GET",
      path: "/api/users",
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
  it("aligns the same path recorded on different hosts (staging vs production)", () => {
    const alignment = alignEndpoints(
      [request("a", "https://staging.example.test/api/users?id=1", 10, 100)],
      [request("b", "https://www.example.test/api/users?id=2", 20, 110)]
    );

    expect(alignment).toEqual([
      expect.objectContaining({ key: "GET /api/users", signal: "stable" })
    ]);
  });

  it("groups many requests of one endpoint in linear time", () => {
    const many = Array.from({ length: 50_000 }, (_, index) =>
      request(String(index), `${API}/poll?n=${index}`, index, 10)
    );
    const startedAt = performance.now();
    const summary = summarizeEndpoints(many);

    expect(summary.get("GET /api/poll")?.count).toBe(50_000);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

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
