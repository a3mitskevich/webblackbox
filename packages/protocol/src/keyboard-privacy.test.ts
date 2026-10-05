import { describe, expect, it } from "vitest";

import {
  REDACTED_KEYSTROKE,
  isServiceKey,
  isShortcutChord,
  redactKeystrokePayload,
  shouldRedactKeystroke,
  type KeystrokePrivacyInput
} from "./keyboard-privacy.js";

function keystroke(overrides: Partial<KeystrokePrivacyInput>): KeystrokePrivacyInput {
  return {
    key: "a",
    editable: true,
    sensitive: false,
    inputs: "length-only",
    ...overrides
  };
}

describe("keyboard privacy", () => {
  it("recognises service keys and rejects printable or modifier-only keys", () => {
    for (const key of ["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "PageDown"]) {
      expect(isServiceKey(key)).toBe(true);
    }
    for (const key of ["F1", "F12", "F24"]) {
      expect(isServiceKey(key)).toBe(true);
    }
    for (const key of ["a", "A", "1", " ", "@", "ж", "F", "F0", "F25", "Shift", "Dead", ""]) {
      expect(isServiceKey(key)).toBe(false);
    }
  });

  it("treats Ctrl/Cmd chords as shortcuts but not AltGr (Ctrl+Alt)", () => {
    expect(isShortcutChord({ ctrlKey: true })).toBe(true);
    expect(isShortcutChord({ metaKey: true })).toBe(true);
    expect(isShortcutChord({ ctrlKey: true, altKey: true })).toBe(false);
    expect(isShortcutChord({ altKey: true })).toBe(false);
    expect(isShortcutChord({})).toBe(false);
  });

  it("redacts printable keys in editable targets unless inputs are allowed", () => {
    for (const inputs of ["none", "length-only", "masked"] as const) {
      expect(shouldRedactKeystroke(keystroke({ inputs }))).toBe(true);
    }
    expect(shouldRedactKeystroke(keystroke({ inputs: "allow" }))).toBe(false);
    expect(shouldRedactKeystroke(keystroke({ ctrlKey: true, altKey: true }))).toBe(true);
  });

  it("keeps service keys and shortcut chords in editable targets", () => {
    expect(shouldRedactKeystroke(keystroke({ key: "Enter" }))).toBe(false);
    expect(shouldRedactKeystroke(keystroke({ key: "s", ctrlKey: true }))).toBe(false);
    expect(shouldRedactKeystroke(keystroke({ key: "c", metaKey: true }))).toBe(false);
  });

  it("keeps keys on non-editable targets", () => {
    expect(shouldRedactKeystroke(keystroke({ editable: false }))).toBe(false);
    expect(shouldRedactKeystroke(keystroke({ editable: false, inputs: "none" }))).toBe(false);
  });

  it("redacts everything but service keys on sensitive targets regardless of policy", () => {
    expect(shouldRedactKeystroke(keystroke({ sensitive: true, inputs: "allow" }))).toBe(true);
    expect(
      shouldRedactKeystroke(keystroke({ sensitive: true, inputs: "allow", ctrlKey: true }))
    ).toBe(true);
    expect(shouldRedactKeystroke(keystroke({ sensitive: true, editable: false }))).toBe(true);
    expect(shouldRedactKeystroke(keystroke({ sensitive: true, key: "Tab" }))).toBe(false);
  });

  it("replaces the key, drops code and keeps other fields without mutating input", () => {
    const payload = { key: "x", code: "KeyX", shiftKey: true, target: { tag: "INPUT" } };
    const redacted = redactKeystrokePayload(payload);

    expect(redacted).toEqual({
      key: REDACTED_KEYSTROKE,
      keyRedacted: true,
      shiftKey: true,
      target: { tag: "INPUT" }
    });
    expect(payload).toEqual({ key: "x", code: "KeyX", shiftKey: true, target: { tag: "INPUT" } });
  });
});
