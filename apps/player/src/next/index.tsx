import { createRoot } from "react-dom/client";

import { readThemePreference } from "../core/preferences.js";
import { applyPlayerDocumentLocale, detectPlayerLocale } from "../lib/i18n.js";
import { App } from "./app.js";
import { createPlayerController, type PlayerController } from "./controller.js";
import { createInitialState } from "./state.js";
import { createStore } from "./store.js";

/** Mounts the React player (`?ui=next`) into `root`. */
export function mountNextPlayer(root: HTMLElement): void {
  const locale = detectPlayerLocale();
  applyPlayerDocumentLocale(locale);

  const store = createStore(createInitialState(locale, readThemePreference()));
  const controller = createPlayerController(store);

  createRoot(root).render(<App controller={controller} />);
  bindPageLifecycle(window, controller);
}

/**
 * Releases the controller when the page goes away. A page kept in the back/forward cache comes back
 * as it was, so it only stops playing and keeps its media URLs.
 */
export function bindPageLifecycle(
  target: EventTarget,
  controller: Pick<PlayerController, "pause" | "dispose">
): void {
  target.addEventListener("pagehide", (event) => {
    if ((event as PageTransitionEvent).persisted) {
      controller.pause();
      return;
    }

    controller.dispose();
  });
}
