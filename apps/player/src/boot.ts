import "./zod-config.js";

import { resolvePlayerUi } from "./core/preferences.js";

/**
 * Entry point: `?ui=next` mounts the React player (stages R1–R5 of the rewrite); without the flag
 * the classic player in `main.ts` runs unchanged. Each UI is only evaluated when chosen.
 */
async function boot(): Promise<void> {
  if (resolvePlayerUi(window.location.search) === "next") {
    // The classic stylesheet styles bare elements; the React player brings its own (next.css).
    document.querySelector<HTMLLinkElement>('link[rel="stylesheet"][href$="styles.css"]')?.remove();
    const root = document.getElementById("app");

    if (!root) {
      throw new Error("Missing #app root for player.");
    }

    const { mountNextPlayer } = await import("./next/index.js");
    mountNextPlayer(root);
    return;
  }

  await import("./main.js");
}

void boot();
