/* @vitest-environment jsdom */

import type { RawRecorderEvent } from "@webblackbox/recorder";
import { afterEach, describe, expect, it, vi } from "vitest";

import { INJECTED_MESSAGE_SOURCE } from "./injected-hooks.js";
import {
  INJECTED_BRIDGE_BATCH_MAX,
  INJECTED_MARKER_MAX_CHARS,
  installInjectedBridgeListener,
  type InjectedBridgeHost
} from "./lite-injected-bridge.js";

const EVENT = { rawType: "console", payload: { level: "log" }, t: 1_000, mono: 2_000 };

function installBridge(nonce: string | null = null) {
  const removers: Array<() => void> = [];
  const queued: RawRecorderEvent[] = [];
  const markers: string[] = [];
  const host: InjectedBridgeHost = {
    listen: (target, type, listener, options) => {
      const wrapped = listener as EventListener;
      target.addEventListener(type, wrapped, options);
      removers.push(() => target.removeEventListener(type, wrapped, options));
    },
    nonce: () => nonce,
    queueRawEvent: (event) => queued.push(event),
    emitMarker: (message) => markers.push(message),
    tabId: () => 7,
    sid: () => "S-1"
  };

  installInjectedBridgeListener(host);
  return { queued, markers, dispose: () => removers.forEach((remove) => remove()) };
}

function post(data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data, source: window }));
}

let bridge: ReturnType<typeof installBridge> | null = null;

afterEach(() => {
  bridge?.dispose();
  bridge = null;
  vi.useRealTimers();
});

describe("injected bridge", () => {
  it("relays a hooks event as a content event of the host's tab and session", () => {
    bridge = installBridge();
    post({ source: INJECTED_MESSAGE_SOURCE, kind: "capture-event", ...EVENT });

    expect(bridge.queued).toEqual([{ source: "content", tabId: 7, sid: "S-1", ...EVENT }]);
  });

  it("ignores messages of other sources, other windows and unknown raw types", () => {
    bridge = installBridge();
    post({ source: "someone-else", kind: "capture-event", ...EVENT });
    post({ source: INJECTED_MESSAGE_SOURCE, kind: "capture-event", ...EVENT, rawType: "script" });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: INJECTED_MESSAGE_SOURCE, kind: "capture-event", ...EVENT },
        source: null
      })
    );

    expect(bridge.queued).toEqual([]);
  });

  it("drops forged messages once the host has a nonce", () => {
    bridge = installBridge("nonce-1");
    post({ source: INJECTED_MESSAGE_SOURCE, kind: "capture-event", ...EVENT });
    post({ source: INJECTED_MESSAGE_SOURCE, kind: "capture-event", ...EVENT, nonce: "guess" });
    post({ source: INJECTED_MESSAGE_SOURCE, kind: "capture-event", ...EVENT, nonce: "nonce-1" });

    expect(bridge.queued).toHaveLength(1);
  });

  it("stamps its own time on a non-finite or missing t / mono", () => {
    vi.useFakeTimers({ now: 5_000 });
    bridge = installBridge();

    for (const t of [Number.NaN, Number.POSITIVE_INFINITY, "1", undefined]) {
      post({ source: INJECTED_MESSAGE_SOURCE, kind: "capture-event", ...EVENT, t, mono: t });
    }

    expect(bridge.queued).toHaveLength(4);

    for (const event of bridge.queued) {
      expect(event.t).toBe(5_000);
      expect(Number.isFinite(event.mono)).toBe(true);
    }
  });

  it("drops events whose payload is not an object", () => {
    bridge = installBridge();

    for (const payload of ["text", 1, null, [1, 2], undefined]) {
      post({ source: INJECTED_MESSAGE_SOURCE, kind: "capture-event", ...EVENT, payload });
    }

    expect(bridge.queued).toEqual([]);
  });

  it("relays a batch, skipping malformed items, and ignores an oversized one", () => {
    bridge = installBridge();
    post({
      source: INJECTED_MESSAGE_SOURCE,
      kind: "capture-events",
      events: [EVENT, null, "x", { ...EVENT, rawType: 4 }, { ...EVENT, rawType: "fetch" }]
    });

    expect(bridge.queued.map((event) => event.rawType)).toEqual(["console", "fetch"]);

    post({
      source: INJECTED_MESSAGE_SOURCE,
      kind: "capture-events",
      events: Array.from({ length: INJECTED_BRIDGE_BATCH_MAX + 1 }, () => EVENT)
    });

    expect(bridge.queued).toHaveLength(2);
  });

  it("caps marker text and labels a marker without text", () => {
    bridge = installBridge();
    post({ source: INJECTED_MESSAGE_SOURCE, kind: "marker", message: "m".repeat(5_000) });
    post({ source: INJECTED_MESSAGE_SOURCE, kind: "marker", message: { text: "x" } });

    expect(bridge.markers).toEqual(["m".repeat(INJECTED_MARKER_MAX_CHARS), "Marker"]);
  });
});
