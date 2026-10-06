import type { Direction } from "./navigation.js";
import { RAIL_TABS, type RailTab } from "./url-hash.js";

/** Keyboard commands of the player (PROPOSAL §4). */
export type KeyCommand =
  | { type: "toggle-play" }
  | { type: "seek-by"; deltaMs: "step" | "large-step" | "frame"; direction: Direction }
  | { type: "seek-edge"; edge: "start" | "end" }
  | { type: "step-list"; direction: Direction }
  | { type: "step-error"; direction: Direction }
  | { type: "next-action" }
  | { type: "focus-search" }
  | { type: "select-tab"; tab: RailTab }
  | { type: "open-details" }
  | { type: "close" }
  | { type: "show-shortcuts" }
  | { type: "toggle-rail-wide" }
  | { type: "mark-range"; edge: "start" | "end" }
  | { type: "open-palette" };

/**
 * How a binding is matched (react-hotkeys-hook syntax):
 * - `keys`: physical keys (`event.code`), ignored while the user types in a field. `KeyL` is "l"
 *   on a Russian layout too, so the map works whatever the layout;
 * - `keys-in-fields`: physical keys that also work in a field (Esc, Ctrl+K);
 * - `character`: the typed character, whatever the physical key (`?` is Shift+/ on a US layout
 *   but Shift+7 on a Russian one).
 */
export type KeyBindingMatch = "keys" | "keys-in-fields" | "character";

export type KeyBinding = {
  /** react-hotkeys-hook key combination, lower case. */
  hotkey: string;
  command: KeyCommand;
  match: KeyBindingMatch;
  /** A focused button, link, tab or splitter handles this key itself (Space, Enter). */
  yieldsToControls?: boolean;
};

const seekBy = (deltaMs: "step" | "large-step" | "frame", direction: Direction): KeyCommand => ({
  type: "seek-by",
  deltaMs,
  direction
});

/** The whole keymap; the hook and the shortcut sheet read it. */
export const KEY_BINDINGS: readonly KeyBinding[] = [
  { hotkey: "space", command: { type: "toggle-play" }, match: "keys", yieldsToControls: true },
  { hotkey: "k", command: { type: "toggle-play" }, match: "keys" },
  { hotkey: "arrowleft", command: seekBy("step", -1), match: "keys" },
  { hotkey: "arrowright", command: seekBy("step", 1), match: "keys" },
  { hotkey: "shift+arrowleft", command: seekBy("large-step", -1), match: "keys" },
  { hotkey: "shift+arrowright", command: seekBy("large-step", 1), match: "keys" },
  { hotkey: "comma", command: seekBy("frame", -1), match: "keys" },
  { hotkey: "period", command: seekBy("frame", 1), match: "keys" },
  { hotkey: "home", command: { type: "seek-edge", edge: "start" }, match: "keys" },
  { hotkey: "end", command: { type: "seek-edge", edge: "end" }, match: "keys" },
  { hotkey: "j", command: { type: "step-list", direction: -1 }, match: "keys" },
  { hotkey: "l", command: { type: "step-list", direction: 1 }, match: "keys" },
  { hotkey: "e", command: { type: "step-error", direction: 1 }, match: "keys" },
  { hotkey: "shift+e", command: { type: "step-error", direction: -1 }, match: "keys" },
  { hotkey: "a", command: { type: "next-action" }, match: "keys" },
  { hotkey: "slash", command: { type: "focus-search" }, match: "keys" },
  { hotkey: "ctrl+k", command: { type: "open-palette" }, match: "keys-in-fields" },
  { hotkey: "meta+k", command: { type: "open-palette" }, match: "keys-in-fields" },
  { hotkey: "escape", command: { type: "close" }, match: "keys-in-fields" },
  { hotkey: "?", command: { type: "show-shortcuts" }, match: "character" },
  { hotkey: "enter", command: { type: "open-details" }, match: "keys", yieldsToControls: true },
  { hotkey: "f", command: { type: "toggle-rail-wide" }, match: "keys" },
  { hotkey: "bracketleft", command: { type: "mark-range", edge: "start" }, match: "keys" },
  { hotkey: "bracketright", command: { type: "mark-range", edge: "end" }, match: "keys" },
  ...RAIL_TABS.map(
    (tab, index): KeyBinding => ({
      hotkey: String(index + 1),
      command: { type: "select-tab", tab },
      match: "keys"
    })
  )
];

/** Commands that make sense before an archive is open. */
export const COMMANDS_WITHOUT_ARCHIVE: ReadonlySet<KeyCommand["type"]> = new Set([
  "show-shortcuts",
  "close",
  "open-palette"
]);

/** Comma-separated hotkeys of one match kind (one `useHotkeys` call each). */
export function hotkeysOf(match: KeyBindingMatch): string {
  return KEY_BINDINGS.filter((binding) => binding.match === match)
    .map((binding) => binding.hotkey)
    .join(",");
}

const BINDINGS_BY_HOTKEY = new Map(KEY_BINDINGS.map((binding) => [binding.hotkey, binding]));

/** The binding react-hotkeys-hook matched (its `hotkey` is the trimmed, lower-cased combo). */
export function findKeyBinding(hotkey: string): KeyBinding | null {
  return BINDINGS_BY_HOTKEY.get(hotkey.trim().toLowerCase()) ?? null;
}

/** Shortcut sheet rows: keys and the i18n key of the description. */
export const SHORTCUT_SHEET = [
  { keys: ["Space", "K"], action: "togglePlay" },
  { keys: ["←", "→"], action: "seekStep" },
  { keys: ["Shift ←", "Shift →"], action: "seekLargeStep" },
  { keys: [",", "."], action: "seekFrame" },
  { keys: ["Home", "End"], action: "seekEdges" },
  { keys: ["J", "L"], action: "stepList" },
  { keys: ["E", "Shift E"], action: "stepError" },
  { keys: ["A"], action: "nextAction" },
  { keys: ["/"], action: "search" },
  { keys: ["Ctrl K"], action: "palette" },
  { keys: ["1…8"], action: "tabs" },
  { keys: ["Enter", "Esc"], action: "details" },
  { keys: ["F"], action: "railWide" },
  { keys: ["[", "]"], action: "markRange" },
  { keys: ["?"], action: "shortcuts" }
] as const;

export type ShortcutAction = (typeof SHORTCUT_SHEET)[number]["action"];
