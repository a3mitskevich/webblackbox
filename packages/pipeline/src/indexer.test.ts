import { describe, expect, it } from "vitest";

import type { WebBlackboxEvent } from "@webblackbox/protocol";

import { EventIndexer, INVERTED_INDEX_LIMITS } from "./indexer.js";

function createClick(index: number, label: string): WebBlackboxEvent {
  return {
    v: 1,
    sid: "S-indexer",
    tab: 1,
    id: `E-${index}`,
    t: index,
    mono: index,
    type: "user.click",
    data: { selector: "#save", label }
  };
}

function indexedTerms(indexer: EventIndexer): Map<string, string[]> {
  return new Map(indexer.snapshot().inverted.map((entry) => [entry.term, entry.eventIds]));
}

describe("EventIndexer inverted index limits", () => {
  it("keeps every term while the session is small", () => {
    const indexer = new EventIndexer();
    const count = INVERTED_INDEX_LIMITS.minEventsForDocumentCutoff - 1;

    indexer.addEvents(Array.from({ length: count }, (_, index) => createClick(index, "same")));

    const terms = indexedTerms(indexer);

    expect(terms.get("user.click")).toHaveLength(count);
    expect(terms.get("save")).toHaveLength(count);
  });

  it("leaves out terms found in more than half the events of a large session", () => {
    const indexer = new EventIndexer();
    const count = INVERTED_INDEX_LIMITS.minEventsForDocumentCutoff;

    indexer.addEvents(
      Array.from({ length: count }, (_, index) =>
        createClick(index, index % 2 === 0 ? `even rare-${index}` : `odd rare-${index}`)
      )
    );

    const terms = indexedTerms(indexer);

    expect(terms.has("user.click")).toBe(false);
    expect(terms.has("save")).toBe(false);
    // Exactly half the events: still narrows a search down.
    expect(terms.get("even")).toHaveLength(count / 2);
    expect(terms.get("rare-7")).toEqual(["E-7"]);
  });

  it("caps the total postings by dropping the most frequent terms first", () => {
    const indexer = new EventIndexer({ ...INVERTED_INDEX_LIMITS, maxTotalPostings: 10 });

    indexer.addEvents([
      createClick(1, "alpha beta"),
      createClick(2, "alpha beta"),
      createClick(3, "alpha gamma")
    ]);

    const terms = indexedTerms(indexer);
    const postings = [...terms.values()].reduce((sum, ids) => sum + ids.length, 0);

    expect(postings).toBeLessThanOrEqual(10);
    expect(terms.has("user.click")).toBe(false);
    expect(terms.get("gamma")).toEqual(["E-3"]);
  });
});
