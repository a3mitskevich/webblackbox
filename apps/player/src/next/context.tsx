import { createContext, useContext, useMemo, type ReactNode } from "react";

import { createPlayerI18n, type PlayerI18n } from "../lib/i18n.js";
import type { PlayerController } from "./controller.js";
import type { PlayerState } from "./state.js";
import { useStoreSelector } from "./store.js";

const ControllerContext = createContext<PlayerController | null>(null);

type PlayerProviderProps = {
  controller: PlayerController;
  children: ReactNode;
};

export function PlayerProvider({ controller, children }: PlayerProviderProps) {
  return <ControllerContext.Provider value={controller}>{children}</ControllerContext.Provider>;
}

export function useController(): PlayerController {
  const controller = useContext(ControllerContext);

  if (!controller) {
    throw new Error("useController must be used inside <PlayerProvider>.");
  }

  return controller;
}

/** A slice of the player state; re-renders only when the slice changes (`isEqual`). */
export function usePlayerState<T>(
  selector: (state: PlayerState) => T,
  isEqual?: (left: T, right: T) => boolean
): T {
  return useStoreSelector(useController().store, selector, isEqual);
}

const selectLocale = (state: PlayerState) => state.locale;

/**
 * Messages and Intl formatters of the current locale. Switching the language re-renders every
 * consumer in place — no reload (BACKLOG item 5).
 */
export function useI18n(): PlayerI18n {
  const locale = usePlayerState(selectLocale);
  return useMemo(() => createPlayerI18n(locale), [locale]);
}
