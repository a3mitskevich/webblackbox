/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@zumer/snapdom", () => {
  return {
    snapdom: {
      toBlob: vi.fn()
    }
  };
});

import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  type CapturePolicy,
  type WebBlackboxEvent
} from "@webblackbox/protocol";
import { WebBlackboxRecorder, type RawRecorderEvent } from "@webblackbox/recorder";

import { LiteCaptureAgent } from "./lite-capture-agent.js";

const ALLOW_INPUTS_POLICY: CapturePolicy = {
  ...DEFAULT_CAPTURE_POLICY,
  categories: {
    ...DEFAULT_CAPTURE_POLICY.categories,
    inputs: "allow"
  }
};

type KeyInit = Pick<KeyboardEventInit, "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey">;

function createPipeline(capturePolicy: CapturePolicy = DEFAULT_CAPTURE_POLICY) {
  const recorder = new WebBlackboxRecorder({ ...DEFAULT_RECORDER_CONFIG, capturePolicy });
  const events: WebBlackboxEvent[] = [];
  const agent = new LiteCaptureAgent({
    showIndicator: false,
    emitBatch: (batch: RawRecorderEvent[]) => {
      for (const raw of batch) {
        const { event } = recorder.ingest(raw);

        if (event) {
          events.push(event);
        }
      }
    }
  });

  agent.setRecordingStatus({
    active: true,
    sid: "S-keydown-privacy",
    tabId: 1,
    mode: "lite",
    capturePolicy
  });
  agent.flush();
  events.length = 0;

  return {
    agent,
    keydowns: (): Array<Record<string, unknown>> => {
      agent.flush();
      return events
        .filter((event) => event.type === "user.keydown")
        .map((event) => event.data as Record<string, unknown>);
    },
    markers: (): WebBlackboxEvent[] => {
      agent.flush();
      return events.filter((event) => event.type === "user.marker");
    }
  };
}

function press(target: EventTarget, init: KeyInit): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, composed: true, ...init }));
}

function typeText(target: EventTarget, text: string): void {
  for (const character of text) {
    press(target, { key: character, code: `Key${character.toUpperCase()}` });
  }
}

function byId<T extends Element>(id: string): T {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`missing #${id}`);
  }

  return element as unknown as T;
}

function serialized(payloads: Array<Record<string, unknown>>): string {
  return JSON.stringify(payloads);
}

describe("keydown privacy (lite agent -> recorder)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <input id="password" type="password" />
      <input id="email" type="email" />
      <input id="checkbox" type="checkbox" />
      <textarea id="notes"></textarea>
      <select id="country"><option>a</option></select>
      <div id="editor" contenteditable="true"><p id="editor-line">x</p></div>
      <input id="api-token" name="api-token" type="text" />
      <div id="sensitive-host" data-sensitive><input id="nested-secret" type="text" /></div>
      <div id="shadow-host"></div>
      <button id="button" type="button">Go</button>
    `;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("never stores printable keys typed into a password field under the default policy", () => {
    const { agent, keydowns } = createPipeline();

    typeText(byId("password"), "hunter");
    const payloads = keydowns();

    expect(payloads).toHaveLength(6);
    expect(serialized(payloads)).not.toMatch(/"key":"[hunter]"/);
    expect(serialized(payloads)).not.toContain("KeyH");
    for (const payload of payloads) {
      expect(payload).toMatchObject({ key: "[REDACTED]", keyRedacted: true });
      expect(payload).not.toHaveProperty("code");
    }

    agent.dispose();
  });

  it("redacts printable keys in editable fields when inputs are not allowed", () => {
    const { agent, keydowns } = createPipeline();

    typeText(byId("email"), "a");
    typeText(byId("notes"), "b");
    typeText(byId("country"), "c");
    typeText(byId("editor-line"), "d");
    press(byId("email"), { key: " ", code: "Space" });
    const payloads = keydowns();

    expect(payloads).toHaveLength(5);
    for (const payload of payloads) {
      expect(payload).toMatchObject({ key: "[REDACTED]", keyRedacted: true, editable: true });
      expect(payload).not.toHaveProperty("code");
    }

    agent.dispose();
  });

  it("keeps service keys and shortcut chords in editable fields", () => {
    const { agent, keydowns } = createPipeline();
    const email = byId<HTMLInputElement>("email");

    for (const key of ["Enter", "Tab", "Escape", "Backspace", "ArrowLeft", "Home", "F5"]) {
      press(email, { key, code: key });
    }
    press(email, { key: "s", code: "KeyS", ctrlKey: true });
    press(email, { key: "v", code: "KeyV", metaKey: true });
    const payloads = keydowns();

    expect(payloads.map((payload) => payload.key)).toEqual([
      "Enter",
      "Tab",
      "Escape",
      "Backspace",
      "ArrowLeft",
      "Home",
      "F5",
      "s",
      "v"
    ]);
    expect(payloads.at(-2)).toMatchObject({ code: "KeyS", ctrlKey: true });
    expect(payloads.some((payload) => payload.keyRedacted === true)).toBe(false);

    agent.dispose();
  });

  it("keeps printable keys and shortcuts on non-editable targets", () => {
    const { agent, keydowns } = createPipeline();

    press(document.body, { key: "j", code: "KeyJ" });
    press(byId("button"), { key: "s", code: "KeyS", ctrlKey: true });
    press(byId("checkbox"), { key: " ", code: "Space" });
    const payloads = keydowns();

    expect(payloads).toEqual([
      expect.objectContaining({ key: "j", code: "KeyJ" }),
      expect.objectContaining({ key: "s", code: "KeyS", ctrlKey: true }),
      expect.objectContaining({ key: " ", code: "Space" })
    ]);
    expect(payloads.some((payload) => payload.keyRedacted === true)).toBe(false);

    agent.dispose();
  });

  it("redacts password and blocked-selector keys even when inputs are allowed", () => {
    const { agent, keydowns } = createPipeline(ALLOW_INPUTS_POLICY);

    typeText(byId("email"), "e");
    typeText(byId("password"), "p");
    press(byId("password"), { key: "v", code: "KeyV", ctrlKey: true });
    typeText(byId("api-token"), "t");
    typeText(byId("nested-secret"), "n");
    press(byId("password"), { key: "Enter", code: "Enter" });
    const payloads = keydowns();

    expect(payloads[0]).toMatchObject({ key: "e", code: "KeyE", editable: true });
    for (const payload of payloads.slice(1, 5)) {
      expect(payload).toMatchObject({
        key: "[REDACTED]",
        keyRedacted: true,
        sensitiveTarget: true
      });
      expect(payload).not.toHaveProperty("code");
    }
    expect(payloads[5]).toMatchObject({ key: "Enter", code: "Enter" });

    agent.dispose();
  });

  it("records keys as typed, passwords included, when the profile turns masking off", () => {
    const { agent, keydowns } = createPipeline({
      ...ALLOW_INPUTS_POLICY,
      redaction: { ...ALLOW_INPUTS_POLICY.redaction, contentRedaction: false }
    });

    typeText(byId("password"), "p");
    typeText(byId("api-token"), "t");
    const payloads = keydowns();

    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ key: "p", code: "KeyP", sensitiveTarget: false });
    expect(payloads[1]).toMatchObject({ key: "t", code: "KeyT", sensitiveTarget: false });
    for (const payload of payloads) {
      expect(payload).not.toHaveProperty("keyRedacted");
    }

    agent.dispose();
  });

  it("classifies password fields inside open shadow roots", () => {
    const { agent, keydowns } = createPipeline(ALLOW_INPUTS_POLICY);
    const host = byId<HTMLDivElement>("shadow-host");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<input id="shadow-password" type="password" />`;
    const field = root.getElementById("shadow-password");

    if (!field) {
      throw new Error("missing shadow password");
    }

    typeText(field, "z");
    const payloads = keydowns();

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ key: "[REDACTED]", sensitiveTarget: true });
    expect(serialized(payloads)).not.toContain("KeyZ");

    agent.dispose();
  });

  it("keeps the Ctrl/Cmd+Shift+M marker hotkey working inside editable fields", () => {
    const { agent, markers } = createPipeline();

    press(byId("password"), { key: "M", code: "KeyM", ctrlKey: true, shiftKey: true });
    press(byId("email"), { key: "m", code: "KeyM", metaKey: true, shiftKey: true });

    expect(markers()).toHaveLength(2);

    agent.dispose();
  });
});
