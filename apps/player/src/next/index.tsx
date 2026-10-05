import { createRoot } from "react-dom/client";

import { readThemePreference } from "../core/preferences.js";
import { applyPlayerDocumentLocale, detectPlayerLocale } from "../lib/i18n.js";
import { App } from "./app.js";
import { createPlayerController } from "./controller.js";
import { createInitialState } from "./state.js";
import { createStore } from "./store.js";

/** Mounts the React player (`?ui=next`) into `root`. */
export function mountNextPlayer(root: HTMLElement): void {
  const locale = detectPlayerLocale();
  applyPlayerDocumentLocale(locale);

  const store = createStore(createInitialState(locale, readThemePreference()));
  const controller = createPlayerController(store);

  createRoot(root).render(<App controller={controller} />);
  window.addEventListener("pagehide", () => controller.dispose());
}
