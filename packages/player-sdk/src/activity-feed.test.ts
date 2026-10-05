import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import {
  buildActivityRows,
  routeLabelOf,
  selectActivityItems,
  type ActivityFeedInput,
  type ActivityItem,
  type ActivityRequest
} from "./activity-feed.js";

const ORIGIN = "https://app.example.test/";

function event(
  id: string,
  type: string,
  mono: number,
  data: Record<string, unknown> = {},
  act?: string
): WebBlackboxEvent {
  return {
    v: 1,
    sid: "S-1",
    tab: 1,
    t: mono,
    mono,
    type,
    id,
    data,
    ...(act ? { ref: { act } } : {})
  } as WebBlackboxEvent;
}

function request(
  reqId: string,
  url: string,
  startMono: number,
  extra: Partial<ActivityRequest> = {}
): ActivityRequest {
  return {
    reqId,
    url,
    method: "GET",
    startMono,
    failed: false,
    eventIds: [`q-${reqId}`, `r-${reqId}`],
    ...extra
  };
}

const requests: ActivityRequest[] = [
  request("ok", "https://app.example.test/api/ok", 1500, { status: 200 }),
  request("t1", "https://app.example.test/gw/tournaments/1/active", 9420, { status: 401 }),
  request("t2", "https://app.example.test/gw/tournaments/2/active", 9430, { status: 401 }),
  request("ga", "https://www.google-analytics.com/g/collect", 1910, {
    failed: true,
    errorText: "net::ERR_ADDRESS_INVALID"
  }),
  request("cu", "https://app.example.test/gw/users/casino-user", 10890, { status: 401 })
];

const events: WebBlackboxEvent[] = [
  event("meta", "meta.config", 0),
  event("tabs", "meta.tabs.snapshot", 1),
  event("click1", "user.click", 1470, { target: { selector: "div.error" } }, "A1"),
  event("q-ok", "network.request", 1500, { reqId: "ok" }, "A1"),
  event("r-ok", "network.response", 1600, { reqId: "ok" }, "A1"),
  event("nav1", "nav.commit", 1910, { frame: { url: "https://app.example.test/?lng=ru" } }),
  event("q-ga", "network.request", 1910, { reqId: "ga" }, "A2"),
  event(
    "ga-log",
    "console.entry",
    1911,
    {
      level: "error",
      text: "Failed to load resource",
      url: "https://www.google-analytics.com/g/collect",
      networkRequestId: "ga"
    },
    "A2"
  ),
  event("route1", "nav.hash", 2590, { url: "https://app.example.test/#/error" }, "A2"),
  event("route2", "nav.hash", 6450, { url: "https://app.example.test/#/error" }),
  event("mm", "user.mousemove", 7000),
  event("q-t1", "network.request", 9420, { reqId: "t1" }),
  event("q-t2", "network.request", 9430, { reqId: "t2" }),
  event("ws", "network.ws.open", 9930, {
    url: "wss://app.example.test/proxy-game/game?access_token=x"
  }),
  event("wsf", "network.ws.frame", 9940, { url: "wss://app.example.test/proxy-game/game" }),
  event("click2", "user.click", 10770, {}, "A3"),
  event("q-cu", "network.request", 10890, { reqId: "cu" }, "A3"),
  event(
    "err",
    "error.exception",
    10910,
    { message: "AuthError: rejected", filename: "https://app.example.test/app.js" },
    "A3"
  ),
  event("info", "console.entry", 10920, { level: "info", text: "hello" }),
  event("warn", "console.entry", 10930, {
    level: "warn",
    text: "deprecated api",
    url: "https://cdn.other.test/sdk.js"
  }),
  event("type1", "user.input", 11000, { target: { selector: "#q" } }),
  event("type2", "user.input", 11010, { target: { selector: "#q" } }),
  event("lvl", "storage.local.op", 11020, {}),
  {
    ...event("lvl-err", "perf.longtask", 11030, { message: "boom" }),
    lvl: "error"
  } as WebBlackboxEvent
];

const input: ActivityFeedInput = {
  events,
  requests,
  actions: [
    { actId: "A1", triggerEventId: "click1" },
    { actId: "A2", triggerEventId: "nav1" },
    { actId: "A3", triggerEventId: "click2" }
  ],
  firstPartyUrl: ORIGIN
};

const ids = (items: readonly ActivityItem[]) => items.map((item) => item.eventId);

describe("routeLabelOf", () => {
  it("prefers hash routes, else the path", () => {
    expect(routeLabelOf("https://a.test/#/live/64?x=1")).toBe("#/live/64");
    expect(routeLabelOf("https://a.test/cart?x=1#top")).toBe("/cart");
    expect(routeLabelOf("not a url")).toBe("not a url");
  });
});

describe("selectActivityItems", () => {
  const items = selectActivityItems(input);
  const byId = new Map(items.map((item) => [item.eventId, item]));

  it("keeps the curated rows in time order", () => {
    expect(ids(items)).toEqual([
      "meta",
      "click1",
      "nav1",
      "q-ga",
      "route1",
      "route2",
      "q-t1",
      "q-t2",
      "ws",
      "click2",
      "q-cu",
      "err",
      "warn",
      "type1",
      "type2",
      "lvl-err"
    ]);
  });

  it("marks action triggers and their consequences", () => {
    expect(byId.get("click1")).toMatchObject({ kind: "action", actId: "A1", parentActId: null });
    expect(byId.get("nav1")).toMatchObject({ kind: "navigation", actId: "A2" });
    expect(byId.get("route1")).toMatchObject({ parentActId: "A2", route: "#/error", visit: 1 });
    expect(byId.get("route2")).toMatchObject({ parentActId: null, visit: 2 });
    expect(byId.get("q-cu")).toMatchObject({
      kind: "request",
      reqId: "cu",
      parentActId: "A3",
      isProblem: true
    });
  });

  it("marks problems and third-party rows", () => {
    expect(byId.get("q-ga")).toMatchObject({ isProblem: true, thirdParty: true });
    expect(byId.get("err")).toMatchObject({
      kind: "exception",
      isProblem: true,
      thirdParty: false
    });
    expect(byId.get("warn")).toMatchObject({ kind: "console", isProblem: false, thirdParty: true });
    expect(byId.get("lvl-err")).toMatchObject({ kind: "exception", isProblem: true });
    expect(byId.get("ws")).toMatchObject({ kind: "realtime", thirdParty: false });
  });

  it("adds every request and console line for the search scope", () => {
    const all = ids(selectActivityItems(input, "all"));
    expect(all).toContain("q-ok");
    expect(all).toContain("info");
    expect(all).not.toContain("r-ok");
    expect(all).not.toContain("ga-log");
    expect(all).not.toContain("wsf");
  });

  it("uses the first event of a request without a network.request event", () => {
    const [item] = selectActivityItems({
      events: [event("f", "network.failed", 5, { reqId: "x" })],
      actions: [],
      requests: [
        {
          reqId: "x",
          url: "https://app.example.test/x",
          startMono: 5,
          failed: true,
          eventIds: ["f"]
        }
      ],
      firstPartyUrl: ORIGIN
    });
    expect(item).toMatchObject({ eventId: "f", kind: "request", isProblem: true });
  });
});

describe("buildActivityRows", () => {
  const items = selectActivityItems(input);
  const heads = (rows: { items: ActivityItem[] }[]) =>
    rows.map((row) => `${row.items[0]?.eventId}×${row.items.length}`);

  it("collapses consecutive repeats with the same parent", () => {
    const { rows, hiddenThirdParty } = buildActivityRows(items);
    expect(hiddenThirdParty).toBe(0);
    expect(heads(rows)).toContain("q-t1×2");
    expect(heads(rows)).toContain("type1×2");
    // Same route, but not consecutive: two rows (the second is a "2nd" visit).
    expect(heads(rows)).toContain("route1×1");
    expect(heads(rows)).toContain("route2×1");
  });

  it("hides third-party rows and counts them", () => {
    const { rows, hiddenThirdParty } = buildActivityRows(items, { hideThirdParty: true });
    expect(hiddenThirdParty).toBe(2);
    expect(heads(rows)).not.toContain("q-ga×1");
  });

  it("keeps problems and the actions that caused them for Errors only", () => {
    const { rows, hiddenThirdParty } = buildActivityRows(items, {
      errorsOnly: true,
      hideThirdParty: true
    });
    expect(heads(rows)).toEqual(["q-t1×2", "click2×1", "q-cu×1", "err×1", "lvl-err×1"]);
    expect(hiddenThirdParty).toBe(1);
  });

  it("keeps pinned items (the selection) whatever the filters", () => {
    const pinned = (item: ActivityItem) => item.eventId === "q-ga" || item.eventId === "route2";
    const { rows, hiddenThirdParty } = buildActivityRows(items, {
      errorsOnly: true,
      hideThirdParty: true,
      matches: (item) => item.kind === "exception",
      pinned
    });
    expect(heads(rows)).toEqual(["q-ga×1", "route2×1", "err×1", "lvl-err×1"]);
    expect(hiddenThirdParty).toBe(0);
  });

  it("applies the text filter before grouping", () => {
    const { rows } = buildActivityRows(items, { matches: (item) => item.kind === "request" });
    expect(heads(rows)).toEqual(["q-ga×1", "q-t1×2", "q-cu×1"]);
  });
});
