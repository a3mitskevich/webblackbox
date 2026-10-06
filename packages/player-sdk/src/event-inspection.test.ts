import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import {
  describeEventPhrase,
  endpointPattern,
  findClickReaction,
  inspectEventTarget,
  summarizeActionConsequences,
  type ActionConsequenceRequest
} from "./event-inspection.js";

const API = "https://app.example.test/gw/bff";
const HASH = "a".repeat(64);

function event(
  id: string,
  type: string,
  mono: number,
  data: Record<string, unknown> = {},
  lvl?: WebBlackboxEvent["lvl"]
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
    ...(lvl ? { lvl } : {})
  } as WebBlackboxEvent;
}

const click = event("E-1", "user.click", 1_000, {
  x: 746,
  y: 477,
  button: 0,
  ctrlKey: true,
  viewport: { w: 2_844, h: 1_350, dpr: 1, scrollX: 0, scrollY: 0 },
  target: {
    tag: "IMG",
    classTokens: ["lobby-game-card__img", HASH],
    selector: `selector:${HASH}`,
    rect: { x: 512, y: 336, w: 441, h: 273 },
    readable: { text: "Live table 64", role: "img", css: "#lobbyGame_64 > picture > img" }
  }
});

function request(
  reqId: string,
  path: string,
  startMono: number,
  extra: Partial<ActionConsequenceRequest> = {}
): ActionConsequenceRequest {
  return {
    reqId,
    url: `${API}${path}`,
    method: "GET",
    status: 200,
    failed: false,
    startMono,
    eventIds: [`req-${reqId}`],
    ...extra
  };
}

describe("inspectEventTarget", () => {
  it("reads the selector, element, box, viewport and pointer of a click", () => {
    expect(inspectEventTarget(click)).toEqual({
      selector: "#lobbyGame_64 > picture > img",
      selectorMasked: false,
      text: "Live table 64",
      role: "img",
      testId: null,
      href: null,
      element: '<img class="lobby-game-card__img">',
      rect: { x: 512, y: 336, width: 441, height: 273 },
      viewport: { width: 2_844, height: 1_350 },
      frameOffset: null,
      pointer: { x: 746, y: 477, button: "left", modifiers: ["Ctrl"] }
    });
  });

  it("flags a target the profile kept hashed and drops masked names", () => {
    const hashed = event("E-2", "user.click", 5, {
      x: 1,
      y: 2,
      button: 2,
      target: { tag: "DIV", selector: `selector:${HASH}`, readable: { text: "[MASKED]" } }
    });

    expect(inspectEventTarget(hashed)).toMatchObject({
      selector: null,
      selectorMasked: true,
      text: null,
      element: "<div>",
      rect: null,
      viewport: null,
      pointer: { button: "right", modifiers: [] }
    });
    expect(inspectEventTarget(event("E-3", "console.entry", 1))).toBeNull();
  });
});

describe("findClickReaction", () => {
  it("finds the DOM probe that followed the click", () => {
    const events = [
      click,
      event("E-r0", "user.click.reaction", 1_020, { clickMono: 900, mutated: false, windowMs: 1 }),
      event("E-r1", "user.click.reaction", 1_030, {
        clickMono: 1_000,
        mutated: true,
        latencyMs: 13.5,
        windowMs: 1_000
      })
    ];

    expect(findClickReaction(events, click)).toEqual({
      mutated: true,
      latencyMs: 13.5,
      windowMs: 1_000
    });
    expect(findClickReaction([click], click)).toBeNull();
  });
});

describe("summarizeActionConsequences", () => {
  it("counts everything and lists failures, routes, sockets and errors in time order", () => {
    const summary = summarizeActionConsequences({
      startMono: 1_000,
      endMono: 2_880,
      events: [
        click,
        event("req-r1", "network.request", 1_100, { url: `${API}/tournaments/2/active` }),
        event("E-ws", "network.ws.open", 1_820, { url: "wss://app.example.test/proxy-live/hubs" }),
        event("E-route", "nav.history.push", 1_210, { url: "https://app.example.test/#/live/64" }),
        event("E-log", "console.entry", 1_300, { level: "info", text: "ok" }),
        event("E-err", "console.entry", 1_320, {
          level: "error",
          text: "AuthError: rejected\nat x"
        }),
        event("E-exc", "error.exception", 1_330, { message: "Unhandled" }, "error")
      ],
      requests: [
        request("r1", "/tournaments/2/active", 1_100, { status: 401 }),
        request("r2", "/users/api/v1.0/casino-user", 1_120, { status: 401 }),
        request("r3", "/chats/1", 1_670, { status: 401 }),
        request("r4", "/chats/2", 1_680, { status: 401 }),
        request("r5", "/chats/3", 1_690, { status: 401 }),
        request("r6", "/lobby/state", 1_050),
        request("r7", "/cancelled", 1_060, {
          status: undefined,
          failed: true,
          errorText: "net::ERR_ABORTED"
        })
      ]
    });

    expect(summary).toMatchObject({
      durationMs: 1_880,
      requests: 7,
      failedRequests: 5,
      consoleErrors: 1,
      exceptions: 1,
      webSockets: 1,
      navigations: 1,
      hiddenItems: 0
    });
    expect(summary.items.map((item) => [item.kind, item.offsetMs, item.count])).toEqual([
      ["request", 100, 1],
      ["request", 120, 1],
      ["route", 210, 1],
      ["console-error", 320, 1],
      ["exception", 330, 1],
      ["request", 670, 3],
      ["websocket", 820, 1]
    ]);
    expect(summary.items[2]?.label).toBe("#/live/64");
    expect(summary.items[3]?.label).toBe("AuthError: rejected");
    expect(summary.firstFailure).toMatchObject({ reqId: "r1", status: 401, method: "GET" });
  });

  it("keeps the first maxItems and says how many it left out", () => {
    const summary = summarizeActionConsequences({
      startMono: 0,
      endMono: 100,
      events: [],
      requests: [
        request("a", "/a", 10, { status: 500 }),
        request("b", "/b", 20, { status: 500 }),
        request("c", "/c", 30, { status: 500 })
      ],
      maxItems: 2
    });

    expect(summary.items.map((item) => item.reqId)).toEqual(["a", "b"]);
    expect(summary.hiddenItems).toBe(1);
  });

  it("never lists the action's trigger as its own consequence", () => {
    const reload = event("E-nav", "nav.reload", 0, { url: "https://a.test/" });
    const summary = summarizeActionConsequences({
      startMono: 0,
      endMono: 10,
      events: [reload, event("E-route", "nav.hash", 5, { url: "https://a.test/#/x" })],
      requests: [],
      triggerEventId: "E-nav"
    });

    expect(summary.items.map((item) => item.eventId)).toEqual(["E-route"]);
    expect(summary.navigations).toBe(1);
  });

  it("has no failing moment when nothing failed", () => {
    const summary = summarizeActionConsequences({
      startMono: 0,
      endMono: 0,
      events: [],
      requests: [request("a", "/a", 10)]
    });

    expect(summary).toMatchObject({
      requests: 1,
      failedRequests: 0,
      items: [],
      firstFailure: null
    });
  });
});

describe("describeEventPhrase", () => {
  it("names the verb, the target and the route of user actions", () => {
    expect(describeEventPhrase(click, { route: "#/lobby" })).toEqual({
      verb: "click",
      target: "Live table 64",
      route: "#/lobby",
      detail: null
    });
    expect(
      describeEventPhrase(event("k", "user.keydown", 1, { key: "Enter", target: { tag: "INPUT" } }))
    ).toEqual({ verb: "key", target: "input", route: null, detail: "Enter" });
    expect(describeEventPhrase(event("c", "user.click", 1, { button: 2 })).verb).toBe(
      "right-click"
    );
  });

  it("describes navigation, requests, sockets, console lines and exceptions", () => {
    expect(
      describeEventPhrase(event("n", "nav.commit", 1, { url: "https://a.test/#/lobby?x=1" }))
    ).toMatchObject({ verb: "page-load", detail: "#/lobby" });
    expect(
      describeEventPhrase(event("h", "nav.hash", 1, { url: "https://a.test/#/live/64" }))
    ).toMatchObject({ verb: "route", detail: "#/live/64" });
    expect(
      describeEventPhrase(
        event("q", "network.request", 1, { request: { method: "post", url: `${API}/x` } })
      )
    ).toMatchObject({ verb: "request", detail: `POST ${API}/x` });
    expect(
      describeEventPhrase(event("w", "network.ws.open", 1, { url: "wss://a.test/hub" }))
    ).toMatchObject({ verb: "websocket", detail: "wss://a.test/hub" });
    expect(
      describeEventPhrase(event("l", "console.entry", 1, { level: "error", text: "boom\nstack" }))
    ).toMatchObject({ verb: "console", detail: "boom" });
    expect(
      describeEventPhrase(event("x", "error.exception", 1, { message: "TypeError" }))
    ).toMatchObject({ verb: "exception", detail: "TypeError" });
    expect(describeEventPhrase(event("s", "storage.local.set", 1, { key: "token" }))).toMatchObject(
      { verb: "storage", detail: "token" }
    );
    expect(describeEventPhrase(event("o", "perf.vitals", 1))).toMatchObject({
      verb: "other",
      detail: "perf.vitals"
    });
  });
});

describe("endpointPattern", () => {
  it("replaces id-like segments and drops the query", () => {
    expect(endpointPattern(`${API}/chats/42/messages?since=1`)).toBe(
      "app.example.test/gw/bff/chats/*/messages"
    );
    expect(endpointPattern("/relative/0f8fad5b-d9cb-469f-a165-70867728950e")).toBe("/relative/*");
  });
});
