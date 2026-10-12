/**
 * Paths of the built extension's files, relative to its root, as WXT emits them. The service worker
 * injects and opens these files by path, and the e2e scripts read them from here too (Node runs
 * this file directly: keep it free of imports and TypeScript-only syntax other than types).
 */
export const EXTENSION_FILES = {
  /** Content script: registered at runtime or injected on Start (`entrypoints/content.ts`). */
  contentScript: "content.js",
  /** Page hooks, run in the page's MAIN world (`entrypoints/injected.ts`). */
  injectedHooks: "injected.js",
  /** Capture agent, injected into a recording frame's isolated world on request. */
  contentAgent: "content-agent.js",
  /** Service worker. */
  serviceWorker: "sw.js",
  offscreenPage: "offscreen.html",
  popupPage: "popup.html",
  optionsPage: "options.html",
  sessionsPage: "sessions.html"
} as const;
