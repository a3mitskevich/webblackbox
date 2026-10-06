import { describe, expect, it } from "vitest";

import {
  COMMANDS_WITHOUT_ARCHIVE,
  findKeyBinding,
  hotkeysOf,
  KEY_BINDINGS,
  SHORTCUT_SHEET
} from "./keymap.js";

describe("keymap", () => {
  it("maps the playback keys to physical keys", () => {
    expect(findKeyBinding("space")?.command).toEqual({ type: "toggle-play" });
    expect(findKeyBinding("k")?.command).toEqual({ type: "toggle-play" });
    expect(findKeyBinding("arrowleft")?.command).toEqual({
      type: "seek-by",
      deltaMs: "step",
      direction: -1
    });
    expect(findKeyBinding("shift+arrowright")?.command).toEqual({
      type: "seek-by",
      deltaMs: "large-step",
      direction: 1
    });
    expect(findKeyBinding("comma")?.command).toEqual({
      type: "seek-by",
      deltaMs: "frame",
      direction: -1
    });
    expect(findKeyBinding("period")?.command).toEqual({
      type: "seek-by",
      deltaMs: "frame",
      direction: 1
    });
    expect(findKeyBinding("home")?.command).toEqual({ type: "seek-edge", edge: "start" });
    expect(findKeyBinding("end")?.command).toEqual({ type: "seek-edge", edge: "end" });
  });

  it("maps navigation, panels and dialogs", () => {
    expect(findKeyBinding("j")?.command).toEqual({ type: "step-list", direction: -1 });
    expect(findKeyBinding("L")?.command).toEqual({ type: "step-list", direction: 1 });
    expect(findKeyBinding("e")?.command).toEqual({ type: "step-error", direction: 1 });
    expect(findKeyBinding("shift+e")?.command).toEqual({ type: "step-error", direction: -1 });
    expect(findKeyBinding("a")?.command).toEqual({ type: "next-action" });
    expect(findKeyBinding("slash")?.command).toEqual({ type: "focus-search" });
    expect(findKeyBinding("ctrl+k")?.command).toEqual({ type: "open-palette" });
    expect(findKeyBinding("meta+k")?.command).toEqual({ type: "open-palette" });
    expect(findKeyBinding("?")?.command).toEqual({ type: "show-shortcuts" });
    expect(findKeyBinding("enter")?.command).toEqual({ type: "open-details" });
    expect(findKeyBinding(" escape ")?.command).toEqual({ type: "close" });
    expect(findKeyBinding("3")?.command).toEqual({ type: "select-tab", tab: "console" });
    expect(findKeyBinding("7")?.command).toEqual({ type: "select-tab", tab: "perf" });
    expect(findKeyBinding("8")?.command).toEqual({ type: "select-tab", tab: "compare" });
    expect(findKeyBinding("9")).toBeNull();
    expect(findKeyBinding("x")).toBeNull();
  });

  it("works in fields only for Esc and Ctrl/Cmd+K, and matches ? by character", () => {
    expect(hotkeysOf("keys-in-fields").split(",").sort()).toEqual(["ctrl+k", "escape", "meta+k"]);
    // `?` is Shift+/ on a US layout and Shift+7 on a Russian one: matched by the typed character.
    expect(hotkeysOf("character")).toBe("?");
    expect(hotkeysOf("keys").split(",")).toContain("shift+e");
  });

  it("leaves Space and Enter to focused controls", () => {
    expect(
      KEY_BINDINGS.filter((binding) => binding.yieldsToControls)
        .map((binding) => binding.hotkey)
        .sort()
    ).toEqual(["enter", "space"]);
  });

  it("binds every hotkey once and only to valid commands without an archive", () => {
    const hotkeys = KEY_BINDINGS.map((binding) => binding.hotkey);

    expect(new Set(hotkeys).size).toBe(hotkeys.length);
    expect(hotkeys.every((hotkey) => hotkey === hotkey.toLowerCase())).toBe(true);
    expect([...COMMANDS_WITHOUT_ARCHIVE].sort()).toEqual([
      "close",
      "open-palette",
      "show-shortcuts"
    ]);
  });

  it("documents every shortcut once", () => {
    const actions = SHORTCUT_SHEET.map((row) => row.action);
    expect(new Set(actions).size).toBe(actions.length);
  });
});
