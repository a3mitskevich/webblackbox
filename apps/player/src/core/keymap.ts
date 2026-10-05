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
  | { type: "show-shortcuts" };

/** The parts of a `KeyboardEvent` the map reads; keeps the map testable without a DOM. */
export type KeyInput = {
  key: string;
  code?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** Tag name of the focused element (`INPUT`, `BUTTON`, …). */
  targetTag?: string;
  targetIsEditable?: boolean;
  /** The focused element handles Enter/Space itself (a button, link or tab). */
  targetIsActivatable?: boolean;
};

const TEXT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function isTyping(input: KeyInput): boolean {
  return TEXT_TAGS.has(input.targetTag?.toUpperCase() ?? "") || input.targetIsEditable === true;
}

/**
 * The command for a key press, or `null`. Keys do nothing while the user types in a field; Esc
 * still closes. Space and Enter are left to focused buttons and tabs.
 */
export function resolveKeyCommand(input: KeyInput): KeyCommand | null {
  if (input.key === "Escape") {
    return { type: "close" };
  }

  const withModifier = input.ctrlKey === true || input.metaKey === true;

  if (withModifier && !input.altKey && input.key.toLowerCase() === "k") {
    return { type: "focus-search" };
  }

  if (isTyping(input) || withModifier || input.altKey) {
    return null;
  }

  const direction: Direction = input.shiftKey ? -1 : 1;

  switch (input.key) {
    case " ":
      return input.targetIsActivatable ? null : { type: "toggle-play" };
    case "k":
    case "K":
      return { type: "toggle-play" };
    case "ArrowLeft":
    case "ArrowRight":
      return {
        type: "seek-by",
        deltaMs: input.shiftKey ? "large-step" : "step",
        direction: input.key === "ArrowLeft" ? -1 : 1
      };
    case ",":
    case ".":
      return { type: "seek-by", deltaMs: "frame", direction: input.key === "," ? -1 : 1 };
    case "Home":
    case "End":
      return { type: "seek-edge", edge: input.key === "Home" ? "start" : "end" };
    case "j":
    case "J":
      return { type: "step-list", direction: -1 };
    case "l":
    case "L":
      return { type: "step-list", direction: 1 };
    case "e":
    case "E":
      return { type: "step-error", direction };
    case "a":
    case "A":
      return { type: "next-action" };
    case "/":
      return { type: "focus-search" };
    case "?":
      return { type: "show-shortcuts" };
    case "Enter":
      return input.targetIsActivatable ? null : { type: "open-details" };
    default:
      break;
  }

  const digit = /^Digit([1-9])$/.exec(input.code ?? "")?.[1] ?? /^[1-9]$/.exec(input.key)?.[0];
  const tab = digit ? RAIL_TABS[Number(digit) - 1] : undefined;

  return tab && !input.shiftKey ? { type: "select-tab", tab } : null;
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
  { keys: ["/", "Ctrl K"], action: "search" },
  { keys: ["1…7"], action: "tabs" },
  { keys: ["Enter", "Esc"], action: "details" },
  { keys: ["?"], action: "shortcuts" }
] as const;

export type ShortcutAction = (typeof SHORTCUT_SHEET)[number]["action"];
