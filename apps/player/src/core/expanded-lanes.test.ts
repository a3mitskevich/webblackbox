import { beforeAll, describe, expect, it } from "vitest";

import { loadSyntheticArchive } from "../next/features/test-archive.js";
import type { LoadedArchive } from "../next/state.js";
import { buildExpandedLanes, FILMSTRIP_MAX_FRAMES } from "./expanded-lanes.js";

let archive: LoadedArchive;

beforeAll(async () => {
  archive = await loadSyntheticArchive();
});

describe("buildExpandedLanes", () => {
  it("places navigation, console, storage, pointer, screenshots, recordings and tabs", () => {
    const lanes = buildExpandedLanes(archive.model, archive.view.window);
    const inside = (ratio: number) => ratio >= 0 && ratio <= 1;

    expect(lanes.navigation.length).toBeGreaterThan(3);
    expect(lanes.console.errorTicks.length).toBeGreaterThan(0);
    expect(lanes.console.marks).toHaveLength(archive.model.consoleSignals.length);
    expect(lanes.storage).toHaveLength(archive.model.storage.length);
    expect(lanes.pointer).toHaveLength(archive.model.pointerLane.length);
    expect(lanes.filmstrip.length).toBe(
      Math.min(archive.model.screenshots.length, FILMSTRIP_MAX_FRAMES)
    );
    expect(lanes.recordings).toHaveLength(archive.model.screenRecordings.length);
    expect(lanes.tabs.length).toBeGreaterThan(0);

    for (const entry of [...lanes.navigation, ...lanes.storage, ...lanes.filmstrip]) {
      expect(inside(entry.ratio)).toBe(true);
      expect(archive.model.eventById.has(entry.eventId)).toBe(true);
    }
  });

  it("thins a dense filmstrip to one frame per slot", () => {
    const shots = Array.from({ length: 1_000 }, (_, index) => ({
      eventId: `shot-${index}`,
      mono: archive.model.minMono + (index / 1_000) * archive.model.durationMono,
      shotId: `s${index}`,
      reason: null,
      format: null,
      size: null,
      marker: null,
      context: null
    }));
    const lanes = buildExpandedLanes({ ...archive.model, screenshots: shots }, archive.view.window);

    expect(lanes.filmstrip.length).toBeLessThanOrEqual(FILMSTRIP_MAX_FRAMES);
    expect(lanes.filmstrip[0]?.eventId).toBe("shot-0");
  });
});
