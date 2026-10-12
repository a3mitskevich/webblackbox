import { WebBlackboxPlayer } from "@webblackbox/player-sdk";
import { beforeAll, describe, expect, it } from "vitest";

import { jsonBytes } from "./budget.js";
import { buildArchiveBytes } from "./test-archive.js";
import { checkoutScenario, WS_FRAME_COUNT } from "./test-scenario.js";
import { buildTimeline, type TimelineRow } from "./timeline.js";

let player: WebBlackboxPlayer;

beforeAll(async () => {
  const { events, blobs } = checkoutScenario();
  player = await WebBlackboxPlayer.open(await buildArchiveBytes(events, blobs));
});

function rowsOf(data: Record<string, unknown>): TimelineRow[] {
  return data.rows as TimelineRow[];
}

describe("timeline", () => {
  it("lists typed rows with ids to drill down, one row per request", () => {
    const { data } = buildTimeline(player, "a.webblackbox", { monoEnd: 1_999 });
    const rows = rowsOf(data);

    expect(rows.map((row) => [row.eventId, row.kind])).toEqual([
      ["E-1", "meta"],
      ["E-2", "navigation"],
      ["E-3", "screen"],
      ["E-5", "action"],
      ["E-7", "network"],
      ["E-11", "console"],
      ["E-12", "error"],
      ["E-13", "dom"],
      ["E-14", "screen"]
    ]);
    expect(rows.find((row) => row.kind === "action")).toMatchObject({
      actionId: "A-1",
      summary: 'click "Pay now"'
    });
    expect(rows.find((row) => row.kind === "network")).toMatchObject({
      requestId: "R-1",
      actionId: "A-1",
      status: 500,
      durationMs: 210,
      summary: "POST 500 https://shop.example/api/pay (210 ms)"
    });
    expect(rows.find((row) => row.kind === "console")).toMatchObject({ level: "error" });
    expect(data.truncated).toBe(false);
    expect(data.nextCursor).toBeNull();
  });

  it("hides pointer noise by default but counts it, and lists it when asked", () => {
    const hidden = buildTimeline(player, "a", { monoEnd: 1_999 }).data;
    const shown = buildTimeline(player, "a", { monoEnd: 1_999, kinds: ["pointer"] }).data;

    expect(rowsOf(hidden).some((row) => row.kind === "pointer")).toBe(false);
    expect(hidden.countsByKind).toMatchObject({ pointer: 2, network: 1 });
    expect(rowsOf(shown).map((row) => row.type)).toEqual(["user.mousemove", "user.click.reaction"]);
  });

  it("centers a window on an event", () => {
    const { data } = buildTimeline(player, "a", { aroundEventId: "E-12", windowMs: 15 });

    expect(data.window).toEqual({ monoStart: 1_225, monoEnd: 1_255 });
    expect(rowsOf(data).map((row) => row.eventId)).toEqual(["E-11", "E-12", "E-13"]);
  });

  it("pages with limit and cursor through every row exactly once", () => {
    const seen: string[] = [];
    let cursor: string | undefined;

    do {
      const { data } = buildTimeline(player, "a", { limit: 7, cursor });
      seen.push(...rowsOf(data).map((row) => row.eventId));
      cursor = (data.nextCursor as string | null) ?? undefined;
    } while (cursor);

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(9 + 1 + WS_FRAME_COUNT);
  });

  it("keeps a page within maxBytes and flags the cut", () => {
    const { data } = buildTimeline(player, "a", { limit: 500, maxBytes: 2_000 });

    expect(jsonBytes(data.rows)).toBeLessThanOrEqual(2_000);
    expect(data.truncated).toBe(true);
    expect(data.nextCursor).toBe(`o:${rowsOf(data).length}`);
  });

  it("rejects contradictory or unknown windows", () => {
    expect(() => buildTimeline(player, "a", { aroundEventId: "E-1", monoStart: 0 })).toThrow(
      /not both/
    );
    expect(() => buildTimeline(player, "a", { monoStart: 10, monoEnd: 5 })).toThrow(/before/);
    expect(() => buildTimeline(player, "a", { aroundEventId: "nope" })).toThrow(/Unknown eventId/);
  });
});
