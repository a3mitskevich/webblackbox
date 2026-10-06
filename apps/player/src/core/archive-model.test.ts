import { WebBlackboxPlayer } from "@webblackbox/player-sdk";
import { beforeAll, describe, expect, it } from "vitest";

import {
  buildSyntheticSession,
  createPlainArchive,
  SYNTHETIC_DURATION_MS
} from "../../scripts/lib/synthetic-session.mjs";
import {
  buildArchiveModel,
  buildProgressMarkers,
  isErrorEvent,
  type ArchiveModel
} from "./archive-model.js";
import { describeEventRow, isActivityEvent } from "./event-row.js";
import {
  filterActionEntries,
  filterTimelineEvents,
  matchesActionTypeFilter,
  matchesTypeFilter,
  resolveActionScope,
  resolveRequestScope,
  resolveScopeByEventId
} from "./filters.js";
import { buildSessionView, type SessionView } from "./session-view.js";
import {
  buildScreenshotTrail,
  resolveScreenRecordingForMono,
  resolveScreenshotMarker,
  resolveShotForMono
} from "./stage-media.js";

const LABELS = {
  pointerReasonClick: "click",
  pointerReasonMove: "move",
  formatPointerKind: (kind: string) => `kind:${kind}`
};

let player: WebBlackboxPlayer;
let model: ArchiveModel;
let view: SessionView;

beforeAll(async () => {
  player = await WebBlackboxPlayer.open(await createPlainArchive());
  model = buildArchiveModel(player, LABELS);
  view = buildSessionView(player.archive, model);
});

const at = (offsetMs: number) => model.minMono + offsetMs;

describe("buildArchiveModel", () => {
  it("indexes the session on the playback clock", () => {
    expect(model.events.length).toBe(buildSyntheticSession().events.length);
    expect(model.durationMono).toBe(SYNTHETIC_DURATION_MS);
    expect(
      model.events.every(
        (event, index) => index === 0 || event.mono >= (model.events[index - 1]?.mono ?? 0)
      )
    ).toBe(true);
    expect(model.waterfall).toHaveLength(20);
    expect(model.waterfallByReqId.get("90080.1706")?.status).toBe(401);
    expect(model.screenshots).toHaveLength(5);
    expect(model.realtime.length).toBeGreaterThan(8);
    expect(model.storage).toHaveLength(2);
    expect(model.actionTimeline.length).toBeGreaterThanOrEqual(5);
    expect(model.tabsContext.summary.distinctTabs).toBe(2);
    expect(model.totals.errors).toBe(1);
    expect(model.pointers.some((pointer) => pointer.click && pointer.reason === "click")).toBe(
      true
    );
    expect(model.pointerLane.every((mark) => mark.label.startsWith("kind:"))).toBe(true);
    expect(model.errorPrefix[model.errorPrefix.length - 1]).toBe(1);
  });

  it("builds progress markers per kind", () => {
    const kinds = new Set(model.progressMarkers.map((marker) => marker.kind));

    expect([...kinds].sort()).toEqual(["action", "error", "network", "screenshot"]);
    expect(buildProgressMarkers([], 0, 0)).toEqual([]);
  });

  it("uses the classic error rule", () => {
    const exception = model.events.find((event) => event.type === "error.exception");
    const consoleError = model.events.find((event) => event.type === "console.entry");

    expect(exception && isErrorEvent(exception)).toBe(true);
    expect(consoleError && isErrorEvent(consoleError)).toBe(false);
  });
});

describe("filters", () => {
  it("filters events by text, type and scope up to the playhead", () => {
    const all = { text: "", type: "all", scope: "all" } as const;
    const visible = model.events.length;

    expect(filterTimelineEvents(model, visible, all)).toHaveLength(visible);
    expect(filterTimelineEvents(model, 3, all)).toHaveLength(3);
    expect(
      filterTimelineEvents(model, visible, { ...all, text: "CASINO-USER" }).every((event) =>
        JSON.stringify(event).toLowerCase().includes("casino-user")
      )
    ).toBe(true);
    expect(filterTimelineEvents(model, visible, { ...all, type: "errors" })).toHaveLength(1);
    expect(
      filterTimelineEvents(model, visible, { ...all, type: "storage" }).every((event) =>
        event.type.startsWith("storage.")
      )
    ).toBe(true);
    expect(filterTimelineEvents(model, visible, { ...all, scope: "iframe" })).toHaveLength(0);
  });

  it("filters actions and resolves scopes", () => {
    const all = { text: "", type: "all", scope: "all" } as const;
    const actions = model.actionTimeline;

    expect(filterActionEntries(model, actions.length, all)).toHaveLength(actions.length);
    expect(
      filterActionEntries(model, actions.length, { ...all, type: "network" }).every(
        (action) => action.requestCount > 0
      )
    ).toBe(true);
    expect(filterActionEntries(model, actions.length, { ...all, text: "zzz-none" })).toEqual([]);

    const action = actions[0];
    const event = model.events[0];

    expect(action && resolveActionScope(model, action)).toBe("main");
    expect(resolveRequestScope(model, "unknown")).toBe("main");
    expect(resolveScopeByEventId(model, "missing")).toBe("main");
    expect(event && matchesTypeFilter(event, "network")).toBe(false);
    expect(event && matchesTypeFilter(event, "console")).toBe(false);
    expect(action && matchesActionTypeFilter(action, "storage")).toBe(false);
    expect(action && matchesActionTypeFilter(action, "console")).toBe(false);
    expect(action && matchesActionTypeFilter(action, "errors")).toBe(action?.errorCount !== 0);
  });
});

describe("stage media", () => {
  it("resolves the screenshot, marker and trail at a time", () => {
    expect(resolveShotForMono(model.screenshots, at(100))).toBeNull();
    expect(resolveShotForMono(model.screenshots, at(10_890))?.reason).toBe("after-navigation");
    expect(resolveShotForMono([], at(1))).toBeNull();
    expect(resolveScreenRecordingForMono(model.screenRecordings, at(5_000))).toBeNull();

    const trail = buildScreenshotTrail(model.pointers, at(10_800));
    const marker = resolveScreenshotMarker(model.pointers, at(10_800), null);

    expect(trail.length).toBeGreaterThan(1);
    expect(trail.some((point) => point.click)).toBe(true);
    expect(marker).toMatchObject({ x: 384, y: 400 });
    expect(resolveScreenshotMarker([], at(1), { x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
    expect(resolveScreenshotMarker([], at(1), null)).toBeNull();
    expect(buildScreenshotTrail([], at(1))).toEqual([]);
  });
});

describe("buildSessionView", () => {
  it("derives the header facts, chapters and lanes", () => {
    expect(view.meta).toMatchObject({
      origin: "https://app.example.test",
      mode: "full",
      encrypted: false,
      otherTabs: 2,
      hasVideo: false,
      screenshotCount: 5
    });
    expect(view.chapters.map((chapter) => chapter.label)).toEqual([
      "/",
      "↻ /",
      "#/error",
      "#/",
      "#/error",
      "#/lobby",
      "#/live/64"
    ]);
    expect(view.chapters.filter((chapter) => chapter.isErrorRoute)).toHaveLength(2);
    // Problems (player-sdk): failed requests, exceptions and console errors by `data.level`.
    expect(view.problems[0]).toMatchObject({ category: "auth", status: 401, thirdParty: false });
    expect(view.problems.map((group) => group.key)).toContain("net:ERR_ADDRESS_INVALID:third");
    const ownProblems = view.problems.filter((group) => !group.thirdParty);
    expect(ownProblems.length).toBeLessThan(view.problems.length);
    expect(view.errorEvents).toHaveLength(ownProblems.reduce((sum, group) => sum + group.count, 0));
    // The logged AuthError only echoes the exception thrown with it: E stops once, at the throw.
    expect(view.errorEvents.map((event) => event.type)).toContain("error.exception");
    expect(view.errorEvents.map((event) => event.type)).not.toContain("console.entry");
    expect(view.errorEvents.map((event) => event.type)).toContain("network.request");
    expect(view.errorTicks.length).toBeGreaterThan(1);
    expect(view.densityBins.some((bin) => bin.failed)).toBe(true);
    expect(view.realtimeTicks.length).toBeGreaterThan(1);
    expect(view.actionMarks.map((mark) => mark.kind)).toContain("click");
    expect(view.actionMarks.map((mark) => mark.kind)).toContain("navigation");
    expect(view.idleGaps.length).toBeGreaterThan(0);
  });
});

describe("event rows", () => {
  const find = (type: string, predicate: (data: Record<string, unknown>) => boolean = () => true) =>
    model.events.find(
      (event) => event.type === type && predicate(event.data as Record<string, unknown>)
    );

  it("describes requests with their outcome", () => {
    const unauthorized = find("network.request", (data) => data.requestId === "90080.1706");
    const failed = find("network.request", (data) => data.requestId === "90080.1122");
    const ok = find("network.request", (data) => data.requestId === "90080.1700");

    expect(unauthorized && describeEventRow(unauthorized, model)).toMatchObject({
      kind: "error",
      primary: "GET /gw/bff/users/api/v1.0/casino-user",
      status: 401,
      isError: true
    });
    expect(failed && describeEventRow(failed, model).secondary).toContain(
      "net::ERR_ADDRESS_INVALID"
    );
    expect(ok && describeEventRow(ok, model)).toMatchObject({ kind: "request", status: 200 });
  });

  it("describes clicks, navigation, sockets, screenshots and messages", () => {
    const click = find("user.click");
    const navigation = find("nav.hash");
    const socket = find("network.ws.open");
    const shot = find("screen.screenshot");
    const console = find("console.entry");
    const snapshot = find("storage.local.snapshot");

    expect(click && describeEventRow(click, model)).toMatchObject({
      kind: "action",
      primary: "“500 Error — Try reloading the page”",
      secondary: "div.error-page__wrapper button"
    });
    expect(navigation && describeEventRow(navigation, model)).toMatchObject({
      kind: "navigation",
      secondary: "historyApi"
    });
    expect(socket && describeEventRow(socket, model)).toMatchObject({
      kind: "realtime",
      secondary: "app.example.test"
    });
    expect(shot && describeEventRow(shot, model)).toMatchObject({
      kind: "media",
      secondary: "960×540"
    });
    expect(console && describeEventRow(console, model).kind).toBe("console");
    expect(snapshot && describeEventRow(snapshot, model)).toMatchObject({
      kind: "storage",
      primary: "start"
    });
  });

  it("hides low-level companions from the activity list", () => {
    const companions = model.events
      .filter((event) => !isActivityEvent(event))
      .map((event) => event.type);

    expect(new Set(companions)).toEqual(
      new Set([
        "network.response",
        "network.finished",
        "network.body",
        "network.ws.frame",
        "user.mousemove"
      ])
    );
  });
});
