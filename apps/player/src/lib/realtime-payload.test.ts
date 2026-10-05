import { describe, expect, it } from "vitest";

import { formatRealtimePayload } from "./realtime-payload.js";

const RS = "\u001e";
const recordLabel = (index: number, count: number): string => `Record ${index} of ${count}`;

describe("formatRealtimePayload", () => {
  it("pretty-prints a JSON frame", () => {
    expect(formatRealtimePayload('{"type":3,"result":{"ok":true}}', recordLabel)).toBe(
      ["{", '  "type": 3,', '  "result": {', '    "ok": true', "  }", "}"].join("\n")
    );
  });

  it("splits SignalR records on the record separator and formats each", () => {
    const text = `{"protocol":"json","version":1}${RS}{"type":6}${RS}`;

    expect(formatRealtimePayload(text, recordLabel)).toBe(
      [
        "── Record 1 of 2 ──",
        "{",
        '  "protocol": "json",',
        '  "version": 1',
        "}",
        "",
        "── Record 2 of 2 ──",
        "{",
        '  "type": 6',
        "}"
      ].join("\n")
    );
  });

  it("keeps a single SignalR record without a header", () => {
    expect(formatRealtimePayload(`{"type":6}${RS}`, recordLabel)).toBe('{\n  "type": 6\n}');
  });

  it("keeps non-JSON and broken JSON text as it is", () => {
    expect(formatRealtimePayload("PING 42", recordLabel)).toBe("PING 42");
    // A frame cut at the body limit is no longer valid JSON.
    expect(formatRealtimePayload('{"type":3,"result":{"da', recordLabel)).toBe(
      '{"type":3,"result":{"da'
    );
  });
});
