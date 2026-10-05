import { describe, expect, it } from "vitest";

import { resolveKeyCommand, SHORTCUT_SHEET } from "./keymap.js";

describe("resolveKeyCommand", () => {
  it("maps the playback keys", () => {
    expect(resolveKeyCommand({ key: " " })).toEqual({ type: "toggle-play" });
    expect(resolveKeyCommand({ key: "k" })).toEqual({ type: "toggle-play" });
    expect(resolveKeyCommand({ key: "ArrowLeft" })).toEqual({
      type: "seek-by",
      deltaMs: "step",
      direction: -1
    });
    expect(resolveKeyCommand({ key: "ArrowRight", shiftKey: true })).toEqual({
      type: "seek-by",
      deltaMs: "large-step",
      direction: 1
    });
    expect(resolveKeyCommand({ key: "," })).toEqual({
      type: "seek-by",
      deltaMs: "frame",
      direction: -1
    });
    expect(resolveKeyCommand({ key: "." })).toEqual({
      type: "seek-by",
      deltaMs: "frame",
      direction: 1
    });
    expect(resolveKeyCommand({ key: "Home" })).toEqual({ type: "seek-edge", edge: "start" });
    expect(resolveKeyCommand({ key: "End" })).toEqual({ type: "seek-edge", edge: "end" });
  });

  it("maps navigation, panels and dialogs", () => {
    expect(resolveKeyCommand({ key: "j" })).toEqual({ type: "step-list", direction: -1 });
    expect(resolveKeyCommand({ key: "L" })).toEqual({ type: "step-list", direction: 1 });
    expect(resolveKeyCommand({ key: "e" })).toEqual({ type: "step-error", direction: 1 });
    expect(resolveKeyCommand({ key: "E", shiftKey: true })).toEqual({
      type: "step-error",
      direction: -1
    });
    expect(resolveKeyCommand({ key: "a" })).toEqual({ type: "next-action" });
    expect(resolveKeyCommand({ key: "/" })).toEqual({ type: "focus-search" });
    expect(resolveKeyCommand({ key: "k", ctrlKey: true })).toEqual({ type: "focus-search" });
    expect(resolveKeyCommand({ key: "K", metaKey: true })).toEqual({ type: "focus-search" });
    expect(resolveKeyCommand({ key: "?", shiftKey: true })).toEqual({ type: "show-shortcuts" });
    expect(resolveKeyCommand({ key: "Enter" })).toEqual({ type: "open-details" });
    expect(resolveKeyCommand({ key: "Escape" })).toEqual({ type: "close" });
    expect(resolveKeyCommand({ key: "3", code: "Digit3" })).toEqual({
      type: "select-tab",
      tab: "console"
    });
    expect(resolveKeyCommand({ key: "7" })).toEqual({ type: "select-tab", tab: "perf" });
    expect(resolveKeyCommand({ key: "8" })).toBeNull();
    expect(resolveKeyCommand({ key: "!", code: "Digit1", shiftKey: true })).toBeNull();
  });

  it("stays out of the way of fields, buttons and browser shortcuts", () => {
    expect(resolveKeyCommand({ key: "e", targetTag: "INPUT" })).toBeNull();
    expect(resolveKeyCommand({ key: " ", targetTag: "textarea" })).toBeNull();
    expect(resolveKeyCommand({ key: "j", targetIsEditable: true })).toBeNull();
    expect(resolveKeyCommand({ key: "Escape", targetTag: "INPUT" })).toEqual({ type: "close" });
    expect(resolveKeyCommand({ key: " ", targetIsActivatable: true })).toBeNull();
    expect(resolveKeyCommand({ key: "Enter", targetIsActivatable: true })).toBeNull();
    expect(resolveKeyCommand({ key: "e", targetIsActivatable: true })).toEqual({
      type: "step-error",
      direction: 1
    });
    expect(resolveKeyCommand({ key: "r", ctrlKey: true })).toBeNull();
    expect(resolveKeyCommand({ key: "ArrowLeft", altKey: true })).toBeNull();
    expect(resolveKeyCommand({ key: "x" })).toBeNull();
  });

  it("documents every shortcut once", () => {
    const actions = SHORTCUT_SHEET.map((row) => row.action);
    expect(new Set(actions).size).toBe(actions.length);
  });
});
