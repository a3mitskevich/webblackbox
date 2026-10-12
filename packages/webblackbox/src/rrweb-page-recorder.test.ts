/* @vitest-environment jsdom */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CAPTURE_POLICY,
  RRWEB_RAW_TYPE,
  type RrwebEventBatchPayload
} from "@webblackbox/protocol";
import type { RawRecorderEvent } from "@webblackbox/recorder";

import {
  createPageWorldDomRecorderFactory,
  DOM_RECORDER_COMMAND_EVENT,
  DOM_RECORDER_MESSAGE_KIND,
  DOM_RECORDER_NONCE_SETTER_KEY
} from "./dom-recorder-bridge.js";
import { INJECTED_MESSAGE_SOURCE } from "./injected-hooks.js";
import { LiteCaptureAgent } from "./lite-capture-agent.js";
import { installPageDomRecorder } from "./rrweb-page-recorder.js";

const NONCE = "nonce-1234";
const posted: Array<Record<string, unknown>> = [];

/** jsdom's postMessage leaves `event.source` empty; Chrome sets it to the posting window. */
const originalPostMessage = window.postMessage.bind(window);

beforeAll(() => {
  window.postMessage = ((data: unknown) => {
    posted.push(data as Record<string, unknown>);
    setTimeout(() => {
      window.dispatchEvent(new MessageEvent("message", { data, source: window }));
    }, 0);
  }) as typeof window.postMessage;
  document.body.innerHTML = `<main id="app"><h1>Orders</h1><button id="pay">Pay</button></main>`;
  installPageDomRecorder();
});

afterAll(() => {
  window.postMessage = originalPostMessage;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const setter = () =>
  (window as unknown as Record<string, (nonce: string) => void>)[DOM_RECORDER_NONCE_SETTER_KEY]!;

describe("page-world rrweb recorder", () => {
  it("defines only its hidden nonce setter, once", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, DOM_RECORDER_NONCE_SETTER_KEY);

    expect(descriptor).toMatchObject({ enumerable: false, writable: false, configurable: false });
    expect(Object.keys(window)).not.toContain(DOM_RECORDER_NONCE_SETTER_KEY);

    const before = setter();
    installPageDomRecorder();
    expect(setter()).toBe(before);
    expect(posted.at(0)).toEqual({
      source: INJECTED_MESSAGE_SOURCE,
      kind: DOM_RECORDER_MESSAGE_KIND,
      signal: "ready"
    });
  });

  it("stamps its messages once the service worker handed it the nonce", () => {
    setter()(NONCE);

    expect(posted.at(-1)).toEqual({
      source: INJECTED_MESSAGE_SOURCE,
      kind: DOM_RECORDER_MESSAGE_KIND,
      signal: "ready",
      nonce: NONCE
    });
  });

  it("ignores malformed commands", () => {
    const count = posted.length;
    window.dispatchEvent(
      new CustomEvent(DOM_RECORDER_COMMAND_EVENT, { detail: { command: "start", session: 1 } })
    );

    expect(posted).toHaveLength(count);
  });

  it("records through the agent: start, batches over the bridge, drain on Stop", async () => {
    const emitted: RawRecorderEvent[] = [];
    const agent = new LiteCaptureAgent({
      emitBatch: (events) => emitted.push(...events),
      frameScope: "top",
      domRecorder: createPageWorldDomRecorderFactory()
    });
    const status = {
      sid: "S-1",
      tabId: 3,
      mode: "lite" as const,
      capturePolicy: DEFAULT_CAPTURE_POLICY,
      injectedBridgeNonce: NONCE
    };

    agent.setRecordingStatus({ ...status, active: true });
    await settle();
    document.getElementById("pay")!.textContent = "Paid";
    await settle();
    await agent.prepareStopCapture();
    agent.setRecordingStatus({ ...status, active: false });
    agent.flush();

    const batches = emitted
      .filter((event) => event.rawType === RRWEB_RAW_TYPE)
      .map((event) => event.payload as RrwebEventBatchPayload);
    const types = batches.flatMap((batch) => batch.events.map((event) => event.type));

    expect(types).toContain(2);
    expect(types).toContain(3);
    // The agent's own summaries stay off while rrweb records.
    expect(emitted.some((event) => event.rawType === "rrweb")).toBe(false);
    agent.dispose();
  });

  it("drops batches a page forges without the nonce", async () => {
    const emitted: RawRecorderEvent[] = [];
    const agent = new LiteCaptureAgent({
      emitBatch: (events) => emitted.push(...events),
      frameScope: "top",
      domRecorder: createPageWorldDomRecorderFactory({
        dispatch: () => undefined,
        setTimeout: (callback, ms) => window.setTimeout(callback, ms),
        clearTimeout: (timer) => window.clearTimeout(timer)
      })
    });
    agent.setRecordingStatus({
      active: true,
      sid: "S-2",
      mode: "lite",
      capturePolicy: DEFAULT_CAPTURE_POLICY,
      injectedBridgeNonce: NONCE
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        data: {
          source: INJECTED_MESSAGE_SOURCE,
          kind: DOM_RECORDER_MESSAGE_KIND,
          signal: "batch",
          session: 1,
          mono: 1,
          payload: { schema: "rrweb/v2", events: [{ type: 2, timestamp: 1, data: {} }] }
        }
      })
    );
    await settle();
    agent.flush();

    expect(emitted.some((event) => event.rawType === RRWEB_RAW_TYPE)).toBe(false);
    agent.dispose();
  });

  it("takes over with the agent's own DOM capture when the page recorder never answers", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<main id="app"><p>quiet</p></main>`;
    const emitted: RawRecorderEvent[] = [];
    const agent = new LiteCaptureAgent({
      emitBatch: (events) => emitted.push(...events),
      frameScope: "top",
      domRecorder: createPageWorldDomRecorderFactory({
        dispatch: () => undefined,
        setTimeout: (callback, ms) => window.setTimeout(callback, ms),
        clearTimeout: (timer) => window.clearTimeout(timer)
      })
    });
    agent.setRecordingStatus({
      active: true,
      sid: "S-3",
      mode: "lite",
      capturePolicy: DEFAULT_CAPTURE_POLICY
    });
    vi.advanceTimersByTime(6_000);
    document.querySelector("p")!.textContent = "changed";
    await vi.advanceTimersByTimeAsync(3_000);
    agent.flush();

    const rrweb = emitted.filter((event) => event.rawType === RRWEB_RAW_TYPE);
    expect((rrweb[0]?.payload as RrwebEventBatchPayload | undefined)?.recorder).toEqual({
      status: "disabled",
      reason: "start-failed"
    });
    expect(emitted.some((event) => event.rawType === "mutation" || event.rawType === "rrweb")).toBe(
      true
    );
    agent.dispose();
    vi.useRealTimers();
  });
});
