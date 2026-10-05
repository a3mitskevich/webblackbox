import "./zod-config.js";

import { resolvePlayerUi } from "./core/preferences.js";

/**
 * Entry point: `?ui=next` mounts the React player (stages R1–R5 of the rewrite); without the flag
 * the classic player in `main.ts` runs unchanged. Each UI is a separate chunk that brings its own
 * stylesheet (a CSS file Vite loads with the chunk), so only the chosen one is fetched.
 */
async function boot(): Promise<void> {
  if (resolvePlayerUi(window.location.search) === "next") {
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
