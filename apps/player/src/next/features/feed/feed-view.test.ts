import { WebBlackboxPlayer } from "@webblackbox/player-sdk";
import { beforeAll, describe, expect, it } from "vitest";

import { createPlainArchive } from "../../../../scripts/lib/synthetic-session.mjs";
import { buildArchiveModel } from "../../../core/archive-model.js";
import { buildSessionView } from "../../../core/session-view.js";
import { createInitialState, type LoadedArchive } from "../../state.js";
import {
  computeFeedView,
  countActivity,
  describeContext,
  describeFeedItem,
  feedDataOf,
  feedStepItems,
  feedViewOf,
  matchFeedItems,
  type FeedParams
} from "./feed-view.js";
import { feedSlice } from "./slice.js";

let archive: LoadedArchive;

const PARAMS: FeedParams = {
  query: "",
  errorsOnly: false,
  hideThirdParty: true,
  scope: "all",
  expanded: [],
  selectedEventId: null,
  locale: "en"
};

beforeAll(async () => {
  const player = await WebBlackboxPlayer.open(await createPlainArchive());
  const model = buildArchiveModel(player, {
    pointerReasonClick: "click",
    pointerReasonMove: "move",
    formatPointerKind: (kind) => kind
  });
  archive = {
    fileName: "synthetic.webblackbox",
    player,
    model,
    view: buildSessionView(player.archive, model)
  };
});

function texts(params: Partial<FeedParams> = {}) {
  const context = describeContext(archive, params.locale ?? "en");
  return computeFeedView(archive, { ...PARAMS, ...params }).entries.map((entry) => {
    const row = describeFeedItem(entry.item, context);
    return { entry, row, line: [row.code, row.lead, row.subject].filter(Boolean).join(" ") };
  });
}

describe("feed view", () => {
  it("starts with the recording and lists actions, routes and failures", () => {
    const rows = texts();
    expect(rows[0]?.row.lead).toBe("Recording started");
    expect(rows[0]?.row.secondary).toContain("Full capture");
    expect(rows.some((row) => row.line.startsWith("Click “"))).toBe(true);
    expect(rows.some((row) => row.line === "Route #/lobby")).toBe(true);
    expect(rows.some((row) => /^401 GET \/gw\/bff\//.test(row.line))).toBe(true);
    expect(rows.some((row) => row.row.lead === "WebSocket opened")).toBe(true);
  });

  it("flags the first auth failure after the click that caused it", () => {
    const flagged = texts().filter((row) => row.row.flag);
    const afterClick = flagged.find(
      (row) => row.row.flag === "First auth failure after this click"
    );
    // The lobby click's first failure: 401 on tournaments group 2 (10.87 s), not the later ones.
    expect(afterClick?.line).toBe("401 GET /gw/bff/tournaments/api/v1/group/2/active");
    // The session's first first-party problem, outside any action, is flagged on its own.
    expect(flagged.filter((row) => !row.row.flag?.endsWith("after this click"))).toHaveLength(1);
    // One flag per click at most: each retry click failed again and is flagged once.
    const parents = flagged
      .filter((row) => row.row.flag?.endsWith("after this click"))
      .map((row) => row.entry.item.parentActId);
    expect(new Set(parents).size).toBe(parents.length);
    expect(flagged.every((row) => !row.entry.item.thirdParty)).toBe(true);
  });

  it("marks repeated routes with their visit and collapses repeats", () => {
    const rows = texts();
    expect(rows.find((row) => row.row.badge)?.row.badge).toBe("2nd");
    const repeated = rows.find((row) => row.entry.count > 1);
    expect(repeated).toBeDefined();

    const expanded = texts({ expanded: [repeated?.entry.item.eventId ?? ""] });
    const head = expanded.findIndex((row) => row.entry.key === repeated?.entry.key);
    expect(expanded[head]?.entry.expanded).toBe(true);
    expect(expanded[head + 1]?.entry.nested).toBe(true);
    expect(expanded).toHaveLength(rows.length + (repeated?.entry.count ?? 1) - 1);
  });

  it("hides third-party rows by default and counts them", () => {
    const hidden = computeFeedView(archive, PARAMS);
    const shown = computeFeedView(archive, { ...PARAMS, hideThirdParty: false });
    expect(hidden.hiddenThirdParty).toBeGreaterThan(0);
    expect(hidden.entries.some((entry) => entry.item.thirdParty)).toBe(false);
    expect(shown.entries.some((entry) => entry.item.thirdParty)).toBe(true);
    expect(shown.hiddenThirdParty).toBe(0);
  });

  it("keeps the selection listed even when a filter would hide it", () => {
    const thirdParty = computeFeedView(archive, { ...PARAMS, hideThirdParty: false }).entries.find(
      (entry) => entry.item.thirdParty
    );
    const pinned = computeFeedView(archive, {
      ...PARAMS,
      selectedEventId: thirdParty?.item.eventId ?? null
    });
    expect(pinned.entries.map((entry) => entry.item.eventId)).toContain(thirdParty?.item.eventId);
  });

  it("shows only problems and the actions behind them for Errors only", () => {
    const view = computeFeedView(archive, { ...PARAMS, errorsOnly: true });
    expect(view.entries.length).toBeGreaterThan(1);
    expect(view.entries.every((entry) => entry.item.isProblem || entry.item.actId !== null)).toBe(
      true
    );
  });

  it("searches every request and console line, fuzzily and in any word order", () => {
    const view = computeFeedView(archive, { ...PARAMS, query: "casino-user" });
    expect(view.searching).toBe(true);
    expect(view.entries.length).toBeGreaterThan(0);
    const context = describeContext(archive, "en");
    expect(
      view.entries.every((entry) => {
        const row = describeFeedItem(entry.item, context);
        return `${row.subject} ${row.secondary}`.toLowerCase().includes("casino");
      })
    ).toBe(true);
    expect(matchFeedItems(["GET /api/users", "POST /login"], "users get")).toEqual(new Set([0]));
    expect(matchFeedItems(["Ошибка авторизации"], "автор")).toEqual(new Set([0]));
    expect(matchFeedItems(["GET /api/users"], "nothing")).toEqual(new Set());
  });

  it("filters by frame scope", () => {
    const counts = feedDataOf(archive).scopeCounts;
    expect(counts.main).toBe(feedDataOf(archive).curated.length);
    expect(counts.iframe).toBe(0);
    expect(computeFeedView(archive, { ...PARAMS, scope: "main" }).entries).toEqual(
      computeFeedView(archive, PARAMS).entries
    );
    expect(computeFeedView(archive, { ...PARAMS, scope: "iframe" }).entries).toHaveLength(0);
  });

  it("counts every event, or the matches of the filter", () => {
    expect(countActivity(archive, "")).toBe(archive.model.events.length);
    expect(countActivity(archive, "casino-user")).toBeGreaterThan(0);
    expect(countActivity(archive, "casino-user")).toBeLessThan(archive.model.events.length);
  });

  it("speaks the locale and memoizes the view for the same filters", () => {
    expect(texts({ locale: "ru" })[0]?.row.lead).toBe("Запись начата");
    expect(texts({ locale: "ru" }).find((row) => row.row.badge)?.row.badge).toBe("2-й");
    const first = feedViewOf(archive, PARAMS);
    expect(feedViewOf(archive, { ...PARAMS })).toBe(first);
    expect(feedViewOf(archive, { ...PARAMS, errorsOnly: true })).not.toBe(first);
    expect(feedDataOf(archive)).toBe(feedDataOf(archive));
  });

  it("gives J / L the listed rows in order", () => {
    const state = {
      ...createInitialState("en", "system"),
      archive,
      slices: { feed: { ...feedSlice.initial, hideThirdParty: false } }
    };
    const items = feedStepItems(archive, state);
    const monos = items.map((item) => item.mono);
    expect(items[0]?.selection.kind).toBe("event");
    expect(monos).toEqual([...monos].sort((left, right) => left - right));
    expect(items).toHaveLength(
      computeFeedView(archive, { ...PARAMS, hideThirdParty: false }).entries.length
    );
  });
});
