import { describe, expect, it } from "vitest";

import { isRrwebEventBatchPayload, RRWEB_EVENT_SCHEMA } from "./rrweb.js";

describe("isRrwebEventBatchPayload", () => {
  it("accepts a batch of rrweb events", () => {
    expect(
      isRrwebEventBatchPayload({
        schema: RRWEB_EVENT_SCHEMA,
        events: [{ type: 4, timestamp: 1_000, data: { href: "https://a.test/" } }]
      })
    ).toBe(true);
  });

  it("rejects lite summaries, foreign schemas and malformed events", () => {
    expect(isRrwebEventBatchPayload({ schema: "rrweb-lite/v1", event: {} })).toBe(false);
    expect(isRrwebEventBatchPayload({ schema: RRWEB_EVENT_SCHEMA, events: "x" })).toBe(false);
    expect(
      isRrwebEventBatchPayload({
        schema: RRWEB_EVENT_SCHEMA,
        events: [{ type: "2", timestamp: 1 }]
      })
    ).toBe(false);
    expect(
      isRrwebEventBatchPayload({
        schema: RRWEB_EVENT_SCHEMA,
        events: [{ type: 2, timestamp: NaN }]
      })
    ).toBe(false);
    expect(isRrwebEventBatchPayload(null)).toBe(false);
  });
});
