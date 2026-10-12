/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CAPTURE_POLICY, type RrwebEventBatchPayload } from "@webblackbox/protocol";

import {
  createPageWorldDomRecorderFactory,
  DOM_RECORDER_BATCH_MAX_EVENTS,
  DOM_RECORDER_DRAIN_TIMEOUT_MS,
  DOM_RECORDER_START_TIMEOUT_MS,
  parseDomRecorderCommand,
  parseDomRecorderPageMessage,
  type DomRecorderCommand
} from "./dom-recorder-bridge.js";

const batch = (events = 1): RrwebEventBatchPayload => ({
  schema: "rrweb/v2",
  events: Array.from({ length: events }, (_, index) => ({ type: 3, timestamp: index, data: {} }))
});

afterEach(() => {
  vi.useRealTimers();
});

describe("parseDomRecorderPageMessage", () => {
  it("accepts the page recorder's signals", () => {
    expect(parseDomRecorderPageMessage({ signal: "ready" })).toEqual({ kind: "ready" });
    expect(parseDomRecorderPageMessage({ signal: "started", session: 3 })).toEqual({
      kind: "started",
      session: 3
    });
    expect(parseDomRecorderPageMessage({ signal: "flushed", token: 9 })).toEqual({
      kind: "flushed",
      token: 9
    });
    expect(
      parseDomRecorderPageMessage({ signal: "batch", session: 1, mono: 12.5, payload: batch() })
    ).toEqual({ kind: "batch", session: 1, mono: 12.5, payload: batch() });
  });

  it("rejects forged or malformed messages", () => {
    expect(parseDomRecorderPageMessage(null)).toBeNull();
    expect(parseDomRecorderPageMessage({ signal: "batch", session: 1, mono: 1 })).toBeNull();
    expect(
      parseDomRecorderPageMessage({
        signal: "batch",
        session: 1,
        mono: Number.NaN,
        payload: batch()
      })
    ).toBeNull();
    expect(
      parseDomRecorderPageMessage({
        signal: "batch",
        session: 1,
        mono: 1,
        payload: { schema: "rrweb-lite/v1", events: [] }
      })
    ).toBeNull();
    expect(
      parseDomRecorderPageMessage({
        signal: "batch",
        session: 1,
        mono: 1,
        payload: batch(DOM_RECORDER_BATCH_MAX_EVENTS + 1)
      })
    ).toBeNull();
    expect(parseDomRecorderPageMessage({ signal: "started", session: -1 })).toBeNull();
    expect(parseDomRecorderPageMessage({ signal: "flushed", token: 1.5 })).toBeNull();
    expect(parseDomRecorderPageMessage({ signal: "explode" })).toBeNull();
  });
});

describe("parseDomRecorderCommand", () => {
  it("accepts the content script's commands", () => {
    expect(
      parseDomRecorderCommand({
        command: "start",
        session: 1,
        policy: DEFAULT_CAPTURE_POLICY,
        mode: "full"
      })
    ).toMatchObject({ command: "start", session: 1, mode: "full" });
    expect(parseDomRecorderCommand({ command: "flush", token: 2 })).toEqual({
      command: "flush",
      token: 2
    });
    expect(parseDomRecorderCommand({ command: "stop", session: 1 })).toEqual({
      command: "stop",
      session: 1
    });
  });

  it("rejects commands a page could dispatch with a broken shape", () => {
    expect(parseDomRecorderCommand({ command: "start", session: 1, mode: "lite" })).toBeNull();
    expect(
      parseDomRecorderCommand({
        command: "start",
        session: 1,
        policy: { categories: {} },
        mode: "lite"
      })
    ).toBeNull();
    expect(
      parseDomRecorderCommand({
        command: "start",
        session: 1,
        policy: DEFAULT_CAPTURE_POLICY,
        mode: "freeze"
      })
    ).toBeNull();
    expect(parseDomRecorderCommand({ command: "stop" })).toBeNull();
    expect(parseDomRecorderCommand("start")).toBeNull();
  });
});

function createHandle() {
  vi.useFakeTimers();
  const commands: DomRecorderCommand[] = [];
  const emitted: Array<{ payload: RrwebEventBatchPayload; mono: number }> = [];
  let disabled = 0;
  const factory = createPageWorldDomRecorderFactory({
    dispatch: (command) => commands.push(command),
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (timer) => window.clearTimeout(timer)
  });
  const recorder = factory({
    policy: DEFAULT_CAPTURE_POLICY,
    mode: "lite",
    emit: (payload, mono) => emitted.push({ payload, mono }),
    onDisabled: () => {
      disabled += 1;
    }
  })!;
  const start = commands[0] as Extract<DomRecorderCommand, { command: "start" }>;
  return { recorder, commands, emitted, start, disabledCount: () => disabled };
}

describe("page-world DOM recorder handle", () => {
  it("starts the page recorder and relays the batches of its own session only", () => {
    const { recorder, commands, emitted, start } = createHandle();

    expect(start).toMatchObject({ command: "start", mode: "lite" });
    recorder.receive?.({ kind: "started", session: start.session });
    recorder.receive?.({ kind: "batch", session: start.session, mono: 5, payload: batch(2) });
    recorder.receive?.({ kind: "batch", session: start.session + 99, mono: 6, payload: batch() });

    expect(emitted).toEqual([{ mono: 5, payload: batch(2) }]);

    recorder.checkpoint?.();
    recorder.stop();
    expect(commands.slice(1)).toEqual([
      { command: "checkpoint", session: start.session },
      { command: "stop", session: start.session }
    ]);

    recorder.receive?.({ kind: "batch", session: start.session, mono: 7, payload: batch() });
    expect(emitted).toHaveLength(1);
  });

  it("starts again when the page recorder reports it installed late", () => {
    const { recorder, commands, start } = createHandle();

    recorder.receive?.({ kind: "ready" });

    expect(commands).toEqual([start, start]);
  });

  it("falls back to the agent's own capture when the page recorder never answers", () => {
    const { emitted, disabledCount, commands, start } = createHandle();

    vi.advanceTimersByTime(DOM_RECORDER_START_TIMEOUT_MS);

    expect(commands.at(-1)).toEqual({ command: "stop", session: start.session });

    expect(emitted.map((entry) => entry.payload)).toEqual([
      {
        schema: "rrweb/v2",
        events: [],
        recorder: { status: "disabled", reason: "start-failed" }
      }
    ]);
    expect(disabledCount()).toBe(1);
  });

  it("does not time out once the page recorder answered", () => {
    const { recorder, start, disabledCount } = createHandle();

    recorder.receive?.({ kind: "started", session: start.session });
    vi.advanceTimersByTime(DOM_RECORDER_START_TIMEOUT_MS * 2);

    expect(disabledCount()).toBe(0);
  });

  it("hands over to the agent when the page recorder disables itself", () => {
    const { recorder, start, disabledCount } = createHandle();
    recorder.receive?.({ kind: "started", session: start.session });

    recorder.receive?.({
      kind: "batch",
      session: start.session,
      mono: 1,
      payload: { ...batch(0), recorder: { status: "disabled", reason: "node-limit" } }
    });
    recorder.receive?.({
      kind: "batch",
      session: start.session,
      mono: 2,
      payload: { ...batch(0), recorder: { status: "disabled", reason: "node-limit" } }
    });

    expect(disabledCount()).toBe(1);
  });

  it("drains on the page recorder's answer, or after a bounded wait", async () => {
    const { recorder, commands } = createHandle();

    const answered = recorder.drain!();
    const flush = commands.at(-1) as Extract<DomRecorderCommand, { command: "flush" }>;
    recorder.receive?.({ kind: "flushed", token: flush.token });
    await expect(answered).resolves.toBeUndefined();

    let settled = false;
    const silent = recorder.drain!().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(DOM_RECORDER_DRAIN_TIMEOUT_MS);
    await silent;
    expect(settled).toBe(true);
  });
});
