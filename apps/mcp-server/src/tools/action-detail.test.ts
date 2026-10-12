import { WebBlackboxPlayer } from "@webblackbox/player-sdk";
import { beforeAll, describe, expect, it } from "vitest";

import { buildActionDetail } from "./action-detail.js";
import { jsonBytes, type CappedList } from "./budget.js";
import { buildArchiveBytes, fixtureEvent } from "./test-archive.js";
import { checkoutScenario } from "./test-scenario.js";

let player: WebBlackboxPlayer;

beforeAll(async () => {
  const { events, blobs } = checkoutScenario();
  player = await WebBlackboxPlayer.open(await buildArchiveBytes(events, blobs));
});

describe("action_detail", () => {
  it("returns the full target as recorded with selector candidates and modifiers", () => {
    const { data } = buildActionDetail(player, "a", { actionId: "A-1" });

    expect(data.trigger).toMatchObject({ eventId: "E-5", type: "user.click", mono: 1_000 });
    expect(data.target).toMatchObject({
      tag: "button",
      id: "pay",
      classes: ["btn", "primary"],
      role: "button",
      text: "Pay now",
      testId: "pay-button",
      frame: "main",
      rect: { x: 10, y: 20, width: 100, height: 30 },
      pointer: { x: 50, y: 35, button: "left", modifiers: ["Ctrl"] }
    });
    expect((data.target as { selectorCandidates: unknown }).selectorCandidates).toEqual([
      { kind: "testId", value: '[data-testid="pay-button"]' },
      { kind: "id", value: "#pay" },
      { kind: "name", value: 'button[name="pay"]' },
      { kind: "role", value: 'getByRole("button", { name: "Pay now" })' },
      { kind: "text", value: 'getByText("Pay now")' },
      { kind: "recordedPath", value: "main > form > button:nth-of-type(2)" }
    ]);
    expect((data.target as { recorded: { json: string } }).recorded.json).toContain('"idToken"');
    expect(data.reaction).toEqual({ mutated: true, latencyMs: 12, windowMs: 500 });
  });

  it("links the requests, errors, console, DOM changes and screenshots the action caused", () => {
    const { data } = buildActionDetail(player, "a", { actionId: "A-1" });

    expect(data.requests).toMatchObject({
      total: 1,
      items: [{ requestId: "R-1", method: "POST", status: 500, offsetMs: 10 }]
    });
    expect(data.errors).toMatchObject({
      total: 1,
      items: [{ eventId: "E-12", kind: "exception" }]
    });
    expect(data.console).toMatchObject({ total: 1, items: [{ eventId: "E-11", level: "error" }] });
    expect(data.dom).toMatchObject({
      total: 1,
      items: [{ eventId: "E-13", count: 3, summaryNote: null }]
    });
    expect(data.screenshots).toEqual({
      before: { eventId: "E-3", mono: 100, deltaMs: -900, reason: "navigation" },
      after: { eventId: "E-14", mono: 1_300, deltaMs: 300, reason: "action" }
    });
    expect(data.consequences).toMatchObject({ failedRequests: 1, exceptions: 1, consoleErrors: 1 });
    expect(data.truncatedLists).toEqual([]);
  });

  it("resolves an event id to the action that holds it", () => {
    const { data } = buildActionDetail(player, "a", { actionId: "E-12" });
    expect(data.action).toMatchObject({ actionId: "A-1", derived: false });
  });

  it("caps linked lists by limit and by maxBytes, naming what it cut", async () => {
    const errors = Array.from({ length: 60 }, (_, index) =>
      fixtureEvent(
        `X-${index}`,
        "error.exception",
        1_010 + index,
        { message: `Failure ${index} ${"z".repeat(200)}` },
        { ref: { act: "B-1" }, lvl: "error" }
      )
    );
    const busy = await WebBlackboxPlayer.open(
      await buildArchiveBytes([
        fixtureEvent(
          "C-1",
          "user.click",
          1_000,
          { target: { tag: "DIV" } },
          { ref: { act: "B-1" } }
        ),
        ...errors,
        fixtureEvent(
          "D-1",
          "dom.mutation.batch",
          1_100,
          { count: 1, summary: { added: "n".repeat(2_000) } },
          { ref: { act: "B-1" } }
        )
      ])
    );
    const limited = buildActionDetail(busy, "a", { actionId: "B-1", limit: 5 }).data;
    const budgeted = buildActionDetail(busy, "a", { actionId: "B-1", limit: 100, maxBytes: 6_000 });
    const budgetedErrors = budgeted.data.errors as CappedList<unknown>;

    expect(limited.errors).toMatchObject({ total: 60, truncated: true });
    expect((limited.errors as CappedList<unknown>).items).toHaveLength(5);
    expect(budgetedErrors.total).toBe(60);
    expect(budgetedErrors.truncated).toBe(true);
    expect(budgetedErrors.items.length).toBeLessThan(60);
    expect(budgeted.data.truncatedLists).toContain("errors");
    expect(jsonBytes(budgeted.data)).toBeLessThanOrEqual(6_500);
    expect((limited.dom as CappedList<unknown>).items[0]).toEqual(
      expect.objectContaining({ summaryNote: "600 of 2012 bytes" })
    );
  });

  it("leaves out the raw target JSON when the lists alone cannot meet maxBytes", async () => {
    const wide = await WebBlackboxPlayer.open(
      await buildArchiveBytes([
        fixtureEvent(
          "W-1",
          "user.click",
          1_000,
          { target: { tag: "DIV", padding: "w".repeat(5_000) } },
          { ref: { act: "W-A" } }
        )
      ])
    );
    const roomy = buildActionDetail(wide, "a", { actionId: "W-A", maxBytes: 20_000 }).data;
    const tight = buildActionDetail(wide, "a", { actionId: "W-A", maxBytes: 4_000 }).data;

    expect(roomy.withinBudget).toBe(true);
    expect((roomy.target as { recorded: { truncated: boolean } }).recorded.truncated).toBe(true);
    expect(tight.target).toMatchObject({ tag: "div", recorded: { json: null, truncated: true } });
    expect(tight.withinBudget).toBe(true);
    expect(jsonBytes(tight)).toBeLessThanOrEqual(4_000);
  });

  it("adds requests and errors of the action's time window the recorder did not link to it", async () => {
    // As in Full-mode archives: the click's own request carries no ref.act, and the next
    // click's request is linked to this action by arrival order.
    const click = (id: string, mono: number, act: string) =>
      fixtureEvent(id, "user.click", mono, { target: { tag: "BUTTON" } }, { ref: { act } });
    const request = (id: string, mono: number, reqId: string, act?: string) =>
      fixtureEvent(
        id,
        "network.request",
        mono,
        { requestId: reqId, request: { method: "GET", url: `https://a/${reqId}` } },
        { ref: { req: reqId, ...(act ? { act } : {}) } }
      );
    const archive = await WebBlackboxPlayer.open(
      await buildArchiveBytes([
        click("K-1", 1_000, "A-1"),
        request("Q-1", 1_004, "own-but-unlinked"),
        fixtureEvent("Q-2", "error.exception", 1_010, { message: "boom" }, { lvl: "error" }),
        click("K-2", 1_200, "A-2"),
        request("Q-3", 1_210, "next-click-request", "A-1"),
        request("Q-4", 3_000, "much-later")
      ])
    );
    const first = buildActionDetail(archive, "a", { actionId: "A-1" }).data;
    const second = buildActionDetail(archive, "a", { actionId: "A-2" }).data;

    expect(first.linking).toMatchObject({ startMono: 1_000, endMono: 1_200, nextActionId: "A-2" });
    expect((first.requests as CappedList<unknown>).items).toEqual([
      expect.objectContaining({
        requestId: "own-but-unlinked",
        link: "time",
        recordedActionId: null,
        offsetMs: 4
      }),
      expect.objectContaining({ requestId: "next-click-request", link: "ref", offsetMs: 210 })
    ]);
    expect((first.errors as CappedList<unknown>).items).toEqual([
      expect.objectContaining({ eventId: "Q-2", link: "time", recordedActionId: null })
    ]);
    expect((second.requests as CappedList<unknown>).items).toEqual([
      expect.objectContaining({
        requestId: "next-click-request",
        link: "time",
        recordedActionId: "A-1"
      })
    ]);
  });

  it("names the tool to take ids from when the action is unknown", () => {
    expect(() => buildActionDetail(player, "a", { actionId: "nope" })).toThrow(/summarize_actions/);
  });
});
