import { beforeAll, describe, expect, it } from "vitest";

import { loadSyntheticArchive } from "../next/features/test-archive.js";
import type { LoadedArchive } from "../next/state.js";
import { actionContentsOf, collectActionRequests, countActionRequests } from "./action-requests.js";

let archive: LoadedArchive;

beforeAll(async () => {
  archive = await loadSyntheticArchive();
});

describe("action requests", () => {
  it("counts every request of an action, beyond the action timeline's first five", () => {
    const contents = actionContentsOf(archive).get("A-000002");
    const counts = countActionRequests(contents?.requests ?? []);
    const timeline = archive.model.actionTimeline.find((action) => action.actId === "A-000002");

    expect(counts).toEqual({ requests: 6, failed: 5 });
    expect(timeline?.requests.length).toBeLessThan(6);
  });

  it("orders requests by start, once each, and does not count a cancellation as a failure", () => {
    const events = archive.model.events.filter((event) => event.ref?.act === "A-000002");
    const requests = collectActionRequests(archive.model, events);

    expect(new Set(requests.map((request) => request.reqId)).size).toBe(requests.length);
    expect(requests.map((request) => request.startMono)).toEqual(
      [...requests.map((request) => request.startMono)].sort((left, right) => left - right)
    );

    const ok = requests.find((request) => !request.failed && (request.status ?? 0) < 400);
    expect(ok).toBeDefined();
    const waterfallByReqId = new Map(archive.model.waterfallByReqId);
    const entry = waterfallByReqId.get(ok?.reqId ?? "");

    if (!entry) {
      throw new Error("request missing from the waterfall");
    }

    waterfallByReqId.set(entry.reqId, {
      ...entry,
      status: undefined,
      failed: true,
      errorText: "net::ERR_ABORTED"
    });
    expect(countActionRequests(collectActionRequests({ waterfallByReqId }, events))).toEqual({
      requests: 6,
      failed: 5
    });

    waterfallByReqId.set(entry.reqId, { ...entry, failed: true, errorText: "net::ERR_FAILED" });
    expect(countActionRequests(collectActionRequests({ waterfallByReqId }, events))).toEqual({
      requests: 6,
      failed: 6
    });
  });

  it("covers actions the SDK inferred from a trigger without ref.act", () => {
    const derived = archive.model.actionTimeline.find(
      (action) => action.actId.startsWith("derived:") && action.requests.length > 0
    );

    if (!derived) {
      throw new Error("the synthetic archive has no inferred action with requests");
    }

    const contents = actionContentsOf(archive).get(derived.actId);
    expect(contents?.events.length).toBeGreaterThan(0);
    expect(contents?.requests.map((request) => request.reqId)).toEqual(
      expect.arrayContaining(derived.requests.map((request) => request.reqId))
    );
  });
});
