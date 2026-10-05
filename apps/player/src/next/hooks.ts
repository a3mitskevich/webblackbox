import { useEffect, useState, type RefObject } from "react";

import { resolveKeyCommand, type KeyCommand } from "../core/keymap.js";
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
  }
}

/** Global keyboard map (PROPOSAL §4); inactive while a modal dialog is open. */
export function useKeyboardShortcuts(searchRef: RefObject<HTMLInputElement | null>): void {
  const controller = useController();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) {
        return;
      }

      const target = event.target instanceof HTMLElement ? event.target : null;

      if (target?.closest("dialog")) {
        return;
      }

      const state = controller.store.getState();
      const command = resolveKeyCommand({
        key: event.key,
        code: event.code,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        targetTag: target?.tagName,
        targetIsEditable: target?.isContentEditable === true,
        targetIsActivatable: Boolean(target?.closest("button, a[href], [role='tab'], summary"))
      });

      if (
        !command ||
        (!state.archive && command.type !== "show-shortcuts" && command.type !== "close")
      ) {
        return;
      }

      if (command.type === "focus-search" && target === searchRef.current) {
        return;
      }

      event.preventDefault();
      runCommand(controller, command, searchRef);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [controller, searchRef]);
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
