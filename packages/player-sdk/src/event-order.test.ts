import { describe, expect, it } from "vitest";

import type { WebBlackboxEvent } from "@webblackbox/protocol";

import {
  compareEventsForTimeline,
  lowerBoundEventMono,
  mergeSortedEventLists,
  sortEventsForTimeline,
  upperBoundEventMono
} from "./event-order.js";

describe("event order", () => {
  it("orders by mono, then wall time, then id", () => {
    const events = [
      createEvent("E-b", 10, 2),
      createEvent("E-a", 10, 2),
      createEvent("E-c", 10, 1),
      createEvent("E-d", 5, 9)
    ];

    expect([...events].sort(compareEventsForTimeline).map((event) => event.id)).toEqual([
      "E-d",
      "E-c",
      "E-a",
      "E-b"
    ]);
  });

  it("compares ids by code point, independent of locale", () => {
    expect(compareEventsForTimeline(createEvent("E-B", 1, 1), createEvent("E-a", 1, 1))).toBe(-1);
    expect(compareEventsForTimeline(createEvent("E-a", 1, 1), createEvent("E-a", 1, 1))).toBe(0);
  });

  it("returns already ordered lists unchanged and sorts unordered ones", () => {
    const ordered = [createEvent("E-1", 1), createEvent("E-2", 2)];
    expect(sortEventsForTimeline(ordered)).toBe(ordered);

    const unordered = [createEvent("E-2", 2), createEvent("E-1", 1)];
    expect(sortEventsForTimeline(unordered).map((event) => event.id)).toEqual(["E-1", "E-2"]);
  });

  it("concatenates disjoint lists and merges overlapping ones", () => {
    const first = [createEvent("E-1", 1), createEvent("E-3", 3)];
    const second = [createEvent("E-4", 4), createEvent("E-5", 5)];
    const overlapping = [createEvent("E-2", 2), createEvent("E-6", 6)];

    expect(mergeSortedEventLists([first, second]).map((event) => event.id)).toEqual([
      "E-1",
      "E-3",
      "E-4",
      "E-5"
    ]);
    expect(
      mergeSortedEventLists([second, [], first, overlapping]).map((event) => event.id)
    ).toEqual(["E-1", "E-2", "E-3", "E-4", "E-5", "E-6"]);
    expect(mergeSortedEventLists([])).toEqual([]);
    expect(mergeSortedEventLists([first])).toBe(first);
  });

  it("does not mutate the merged inputs", () => {
    const first = [createEvent("E-2", 2)];
    const second = [createEvent("E-1", 1)];

    mergeSortedEventLists([first, second]);

    expect(first.map((event) => event.id)).toEqual(["E-2"]);
    expect(second.map((event) => event.id)).toEqual(["E-1"]);
  });

  it("finds mono bounds in ordered lists", () => {
    const events = [createEvent("E-1", 1), createEvent("E-2", 2), createEvent("E-3", 2)];

    expect(lowerBoundEventMono(events, 2)).toBe(1);
    expect(upperBoundEventMono(events, 2)).toBe(3);
    expect(lowerBoundEventMono(events, 9)).toBe(3);
    expect(upperBoundEventMono(events, 0)).toBe(0);
  });
});

function createEvent(id: string, mono: number, t = 1000 + mono): WebBlackboxEvent {
  return { v: 1, sid: "S-1", tab: 1, t, mono, type: "user.mousemove", id, data: {} };
}
