import { describe, expect, it } from "vitest";

import {
  createPortTrafficMeter,
  PORT_TRAFFIC_FLAG,
  PORT_TRAFFIC_STATS_KEY
} from "./port-traffic.js";

describe("port traffic meter", () => {
  it("records nothing while the flag is off", () => {
    const scope: Record<string, unknown> = {};
    const meter = createPortTrafficMeter(scope);

    meter.recordSent("putBlob", { bytes: "AAAA" }, 3);

    expect(meter.snapshot().sent.messages).toBe(0);
    expect(scope[PORT_TRAFFIC_STATS_KEY]).toBeUndefined();
  });

  it("counts the JSON size of each message per direction and kind", () => {
    const scope: Record<string, unknown> = { [PORT_TRAFFIC_FLAG]: true };
    const meter = createPortTrafficMeter(scope);
    const sent = { kind: "sw.pipeline-request", op: "putBlob", bytes: "AAAA" };
    const received = { kind: "offscreen.pipeline-response", ok: true };

    meter.recordSent("putBlob", sent, 3);
    meter.recordSent("putBlob", sent, 3);
    meter.recordReceived("offscreen.pipeline-response", received);

    const stats = meter.snapshot();
    expect(stats.sent).toEqual({
      messages: 2,
      bytes: 2 * JSON.stringify(sent).length,
      binaryBytes: 6
    });
    expect(stats.received).toEqual({
      messages: 1,
      bytes: JSON.stringify(received).length,
      binaryBytes: 0
    });
    expect(stats.byKind.putBlob?.messages).toBe(2);
    expect(scope[PORT_TRAFFIC_STATS_KEY]).toBe(stats);
  });

  it("shows how a Uint8Array grows in its JSON form", () => {
    const scope: Record<string, unknown> = { [PORT_TRAFFIC_FLAG]: true };
    const meter = createPortTrafficMeter(scope);
    const bytes = new Uint8Array(1_000).fill(200);

    meter.recordSent("putBlob", { bytes }, bytes.byteLength);

    expect(meter.snapshot().sent.bytes).toBeGreaterThan(bytes.byteLength * 8);
  });

  it("does not replace the published totals of earlier messages", () => {
    const scope: Record<string, unknown> = { [PORT_TRAFFIC_FLAG]: true };
    const meter = createPortTrafficMeter(scope);

    meter.recordSent("flush", { op: "flush" });
    const first = meter.snapshot();
    meter.recordSent("flush", { op: "flush" });

    expect(first.sent.messages).toBe(1);
    expect(meter.snapshot().sent.messages).toBe(2);
  });
});
