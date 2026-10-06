import { beforeAll, describe, expect, it } from "vitest";

import { loadSyntheticArchive } from "../next/features/test-archive.js";
import type { LoadedArchive } from "../next/state.js";
import { collectActionRequests, countActionRequests } from "./action-requests.js";

let archive: LoadedArchive;

beforeAll(async () => {
  archive = await loadSyntheticArchive();
});

describe("action requests", () => {
  it("counts every request of an action, beyond the action timeline's first five", () => {
    const counts = countActionRequests(archive.model).get("A-000002");
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
    const model = { ...archive.model, waterfallByReqId };
    expect(countActionRequests(model).get("A-000002")).toEqual({ requests: 6, failed: 5 });

    waterfallByReqId.set(entry.reqId, { ...entry, failed: true, errorText: "net::ERR_FAILED" });
    expect(countActionRequests({ ...archive.model, waterfallByReqId }).get("A-000002")).toEqual({
      requests: 6,
      failed: 6
    });
  });
});
