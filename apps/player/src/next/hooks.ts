import { useCallback, useEffect, useState, useSyncExternalStore, type RefObject } from "react";
import { useHotkeys, type HotkeyCallback } from "react-hotkeys-hook";

import {
  COMMANDS_WITHOUT_ARCHIVE,
  findKeyBinding,
  hotkeysOf,
  type KeyBinding,
  type KeyCommand
} from "../core/keymap.js";
import { resolveTheme } from "../core/preferences.js";
import { parseHashState, serializeHashState } from "../core/url-hash.js";
import { hasFilePayload, pickArchiveFile } from "../lib/archive-files.js";
import type { PlayerController } from "./controller.js";
import { useController, usePlayerState } from "./context.js";

/** The URL hash is rewritten once the state has been stable this long (not on every frame). */
const HASH_WRITE_DELAY_MS = 400;

function runCommand(
  controller: PlayerController,
  command: KeyCommand,
  searchRef: RefObject<HTMLInputElement | null>
): void {
  switch (command.type) {
    case "toggle-play":
      controller.togglePlay();
      return;
    case "seek-by":
      controller.seekBy(command.deltaMs, command.direction);
      return;
    case "seek-edge":
      controller.seekEdge(command.edge);
      return;
    case "step-list":
      controller.stepList(command.direction);
      return;
    case "step-error":
      controller.stepError(command.direction);
      return;
    case "next-action":
      controller.nextAction();
      return;
    case "focus-search":
      searchRef.current?.focus();
      searchRef.current?.select();
      return;
    case "select-tab":
      controller.setTab(command.tab);
      return;
    case "open-details":
      controller.openDetails();
      return;
    case "close":
      controller.close();
      return;
    case "show-shortcuts":
      controller.setShortcutsOpen(true);
      return;
    case "toggle-rail-wide":
      controller.toggleRailWide();
      return;
    case "mark-range":
      controller.markRange(command.edge);
      return;
  }
}

const KEYS = hotkeysOf("keys");
const KEYS_IN_FIELDS = hotkeysOf("keys-in-fields");
const CHARACTER_KEYS = hotkeysOf("character");

/** Elements that handle Space / Enter themselves. */
const ACTIVATABLE = "button, a[href], [role='tab'], [role='separator'], summary";
/**
 * Widgets that move with the arrow keys, Home and End themselves (tabs, splitters). The scrubber
 * and the lists are not among them: arrows seek there, as everywhere else.
 */
const ARROW_WIDGETS = "[role='tablist'], [role='separator']";
const WIDGET_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

function targetElement(event: KeyboardEvent): Element | null {
  return event.target instanceof Element ? event.target : null;
}

/** A key some other handler owns: a dialog, IME composition, or a widget that already reacted. */
function isOwnedElsewhere(event: KeyboardEvent): boolean {
  const target = targetElement(event);

  return (
    event.defaultPrevented ||
    event.isComposing ||
    Boolean(target?.closest("[role='dialog'], [role='alertdialog'], dialog")) ||
    (WIDGET_KEYS.has(event.key) && Boolean(target?.closest(ARROW_WIDGETS)))
  );
}

/**
 * `?` matches the typed character with any modifier; Ctrl / Alt / Meta + `?` are not the sheet,
 * but AltGr (reported as Ctrl+Alt on Windows) is how some layouts type `?`.
 */
function isCharacterKeyIgnored(event: KeyboardEvent): boolean {
  const isAltGraph = event.getModifierState?.("AltGraph") === true;
  return (
    isOwnedElsewhere(event) || event.metaKey || (!isAltGraph && (event.ctrlKey || event.altKey))
  );
}

function yieldsToTarget(event: KeyboardEvent, binding: KeyBinding): boolean {
  return binding.yieldsToControls === true && Boolean(targetElement(event)?.closest(ACTIVATABLE));
}

/**
 * Global keyboard map (PROPOSAL §4) on react-hotkeys-hook. Keys match by physical key, so they
 * work on any layout; they stay quiet while the user types in a field (except Esc and Ctrl+K) and
 * while a modal dialog is open (it handles its own keys).
 */
export function useKeyboardShortcuts(searchRef: RefObject<HTMLInputElement | null>): void {
  const controller = useController();

  const handleHotkey = useCallback<HotkeyCallback>(
    (event, hotkey) => {
      const binding = findKeyBinding(hotkey.hotkey);

      if (!binding || yieldsToTarget(event, binding)) {
        return;
      }

      const { command } = binding;

      if (!controller.store.getState().archive && !COMMANDS_WITHOUT_ARCHIVE.has(command.type)) {
        return;
      }

      if (command.type === "focus-search" && event.target === searchRef.current) {
        return;
      }

      event.preventDefault();
      runCommand(controller, command, searchRef);
    },
    [controller, searchRef]
  );

  // The library skips form controls and ARIA widgets; only typing targets should silence the
  // map, so the scrubber (slider) and list rows (option) keep the playback keys.
  useHotkeys(KEYS, handleHotkey, {
    enableOnFormTags: ["slider", "option"],
    ignoreEventWhen: isOwnedElsewhere
  });
  useHotkeys(KEYS_IN_FIELDS, handleHotkey, {
    enableOnFormTags: true,
    ignoreEventWhen: isOwnedElsewhere
  });
  useHotkeys(CHARACTER_KEYS, handleHotkey, {
    useKey: true,
    ignoreModifiers: true,
    enableOnFormTags: ["slider", "option"],
    ignoreEventWhen: isCharacterKeyIgnored
  });
}

/** Whether a media query matches, kept in sync with the window (e.g. the wide two-column layout). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== "function") {
        return () => undefined;
      }

      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query]
  );
  const getSnapshot = (): boolean =>
    typeof window.matchMedia === "function" ? window.matchMedia(query).matches : true;

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Two-way URL hash sync: `#t=…&sel=…&tab=…` is applied on load and on hashchange (a pasted link),
 * and rewritten with replaceState once the playhead, selection or tab rest for a moment
 * (replaceState fires no hashchange, so there is no feedback loop).
 */
export function useHashSync(): void {
  const controller = useController();
  const archive = usePlayerState((state) => state.archive);
  const playheadMono = usePlayerState((state) => state.playheadMono);
  const selection = usePlayerState((state) => state.selection);
  const tab = usePlayerState((state) => state.tab);

  useEffect(() => {
    const applyLocationHash = (): void => {
      controller.applyHash(parseHashState(window.location.hash));
    };

    applyLocationHash();
    window.addEventListener("hashchange", applyLocationHash);
    return () => window.removeEventListener("hashchange", applyLocationHash);
  }, [controller]);

  useEffect(() => {
    if (!archive) {
      return;
    }

    const timer = window.setTimeout(() => {
      const hash = serializeHashState({
        offsetMs: playheadMono - archive.model.minMono,
        selection: selection ?? undefined,
        tab
      });

      if (hash !== window.location.hash) {
        const { pathname, search } = window.location;
        window.history.replaceState(window.history.state, "", `${pathname}${search}${hash}`);
      }
    }, HASH_WRITE_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [archive, playheadMono, selection, tab]);
}

/** `data-theme` on <html> from the preference and the OS colour scheme. */
export function useThemeAttribute(): void {
  const preference = usePlayerState((state) => state.theme);
  const [prefersDark, setPrefersDark] = useState(() =>
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : false
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }

    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event: MediaQueryListEvent): void => setPrefersDark(event.matches);
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolveTheme(preference, prefersDark);
    root.dataset.themePreference = preference;
  }, [preference, prefersDark]);
}

/** The whole window accepts a dropped archive; the overlay shows while a file is dragged over. */
export function useArchiveDropTarget(): void {
  const controller = useController();

  useEffect(() => {
    let depth = 0;

    const handleDragEnter = (event: DragEvent): void => {
      if (!hasFilePayload(event)) {
        return;
      }

      event.preventDefault();
      depth += 1;
      controller.setDragActive(true);
    };

    const handleDragOver = (event: DragEvent): void => {
      if (!hasFilePayload(event)) {
        return;
      }

      event.preventDefault();

      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
    };

    const handleDragLeave = (event: DragEvent): void => {
      if (!hasFilePayload(event)) {
        return;
      }

      depth = Math.max(0, depth - 1);

      if (depth === 0) {
        controller.setDragActive(false);
      }
    };

    const handleDrop = (event: DragEvent): void => {
      if (!hasFilePayload(event)) {
        return;
      }

      event.preventDefault();
      depth = 0;
      controller.setDragActive(false);
      const file = pickArchiveFile(event.dataTransfer?.files ?? null);
      const fallback = event.dataTransfer?.files?.[0];

      if (file) {
        void controller.openFile(file);
      } else if (fallback) {
        void controller.openFile(fallback);
      }
    };

    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);

    return () => {
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDrop);
    };
  }, [controller]);
}
