import { beforeAll, describe, expect, it } from "vitest";

import { loadSyntheticArchive } from "../next/features/test-archive.js";
import type { LoadedArchive } from "../next/state.js";
import { searchPalette } from "./palette-search.js";

let archive: LoadedArchive;

beforeAll(async () => {
  archive = await loadSyntheticArchive();
});

describe("searchPalette", () => {
  it("finds requests by URL and events by selector, text and id", () => {
    const byUrl = searchPalette(archive.model, "casino-user");
    expect(byUrl.reqIds).toContain("90080.1706");

    const bySelector = searchPalette(archive.model, "#lobbyGame_64");
    expect(
      bySelector.eventIds.some((id) => archive.model.eventById.get(id)?.type === "user.click")
    ).toBe(true);

    const someId = archive.model.events[5]?.id ?? "";
    expect(searchPalette(archive.model, someId).eventIds[0]).toBe(someId);
  });

  it("returns nothing for an empty query and caps each group", () => {
    expect(searchPalette(archive.model, "  ")).toEqual({ eventIds: [], reqIds: [] });
    const many = searchPalette(archive.model, "e", 5);
    expect(many.eventIds.length).toBeLessThanOrEqual(5);
    expect(many.reqIds.length).toBeLessThanOrEqual(5);
  });
});
