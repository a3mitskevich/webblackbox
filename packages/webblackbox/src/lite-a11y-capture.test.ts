/* @vitest-environment jsdom */

import { DEFAULT_CAPTURE_POLICY, type CapturePolicy } from "@webblackbox/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { A11Y_SNAPSHOT_RAW_TYPE, LiteA11yCapture } from "./lite-a11y-capture.js";

function setup(policy: CapturePolicy = DEFAULT_CAPTURE_POLICY, topLevel = true) {
  const emitted: Array<Record<string, unknown>> = [];
  const listeners: Array<() => void> = [];
  const capture = new LiteA11yCapture({
    policy: () => policy,
    isRecording: () => true,
    isTopLevelFrame: () => topLevel,
    emit: (rawType, payload) => {
      expect(rawType).toBe(A11Y_SNAPSHOT_RAW_TYPE);
      emitted.push(payload);
    },
    listen: (target, type, listener) => {
      target.addEventListener(type, listener);
      listeners.push(() => target.removeEventListener(type, listener));
    }
  });
  // Without `delayMs`: the settle delays are covered by the scheduler tests.
  const triggers = () =>
    emitted.map((payload) => {
      const trigger = { ...(payload.trigger as Record<string, unknown>) };
      delete trigger.delayMs;
      return trigger;
    });

  return { capture, triggers, cleanup: () => listeners.forEach((remove) => remove()) };
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "<button>Go</button>";
});

afterEach(() => {
  vi.useRealTimers();
  history.replaceState(null, "", "/");
});

describe("LiteA11yCapture", () => {
  it("maps raw events to triggers", () => {
    const { capture, triggers, cleanup } = setup();
    capture.start();
    vi.advanceTimersByTime(2_000);

    const cases: Array<[string, Record<string, unknown>, unknown]> = [
      ["submit", {}, { kind: "action", rawType: "submit" }],
      ["keydown", { key: "Enter" }, { kind: "action", rawType: "keydown" }],
      ["keydown", { key: "a" }, null],
      ["console", { level: "error" }, { kind: "error", rawType: "console" }],
      ["console", { level: "warn" }, null],
      ["pageError", {}, { kind: "error", rawType: "pageError" }],
      ["unhandledrejection", {}, { kind: "error", rawType: "unhandledrejection" }],
      ["marker", { message: "here" }, { kind: "marker", rawType: "marker" }],
      ["mutation", {}, null]
    ];

    for (const [rawType, payload, expected] of cases) {
      const before = triggers().length;
      capture.observe(rawType, payload);
      vi.advanceTimersByTime(2_000);
      expect(triggers().slice(before)).toEqual(expected ? [expected] : []);
    }

    cleanup();
  });

  it("notices route changes from history and hash events and from the URL itself", () => {
    const { capture, triggers, cleanup } = setup();
    capture.start();
    vi.advanceTimersByTime(2_000);

    history.pushState(null, "", "/orders");
    capture.observe("mutation", {});
    vi.advanceTimersByTime(2_000);
    window.dispatchEvent(new PopStateEvent("popstate"));
    vi.advanceTimersByTime(2_000);

    expect(triggers()).toEqual([
      { kind: "navigation", rawType: "document" },
      { kind: "navigation", rawType: "url-change" },
      { kind: "navigation", rawType: "popstate" }
    ]);

    cleanup();
  });

  it("stays off in child frames and without the DOM category", () => {
    const child = setup(DEFAULT_CAPTURE_POLICY, false);
    const noDom = setup({
      ...DEFAULT_CAPTURE_POLICY,
      categories: { ...DEFAULT_CAPTURE_POLICY.categories, dom: "off" }
    });

    for (const { capture } of [child, noDom]) {
      capture.start();
      capture.observe("click", {});
      vi.advanceTimersByTime(5_000);
      capture.stop();
    }

    expect(child.triggers()).toEqual([]);
    expect(noDom.triggers()).toEqual([]);
  });

  it("does not trigger on its own snapshots", () => {
    const { capture, triggers } = setup();
    capture.observe(A11Y_SNAPSHOT_RAW_TYPE, {});
    vi.advanceTimersByTime(5_000);

    expect(triggers()).toEqual([]);
  });
});
