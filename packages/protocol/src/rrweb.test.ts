import { describe, expect, it } from "vitest";

import { isRrwebEventBatchPayload, isRrwebRecorderState, RRWEB_EVENT_SCHEMA } from "./rrweb.js";

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

describe("isRrwebRecorderState", () => {
  it("accepts pressure-mode states", () => {
    expect(isRrwebRecorderState({ status: "paused", reason: "mutation-cost" })).toBe(true);
    expect(isRrwebRecorderState({ status: "resumed" })).toBe(true);
    expect(
      isRrwebRecorderState({ status: "disabled", reason: "element-limit", elements: 40_000 })
    ).toBe(true);
  });

  it("rejects unknown statuses, reasons and counts", () => {
    expect(isRrwebRecorderState({ status: "running" })).toBe(false);
    expect(isRrwebRecorderState({ status: "paused", reason: "boredom" })).toBe(false);
    expect(isRrwebRecorderState({ status: "disabled", elements: "many" })).toBe(false);
    expect(isRrwebRecorderState([])).toBe(false);
  });

  it("is checked on batches that carry one", () => {
    expect(
      isRrwebEventBatchPayload({
        schema: RRWEB_EVENT_SCHEMA,
        events: [],
        recorder: { status: "paused", reason: "mutation-size" }
      })
    ).toBe(true);
    expect(
      isRrwebEventBatchPayload({ schema: RRWEB_EVENT_SCHEMA, events: [], recorder: { status: 1 } })
    ).toBe(false);
  });
});
