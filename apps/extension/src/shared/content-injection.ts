/**
 * When the content script runs in pages: registered for every page from `document_start`
 * ("always", the default), or injected only into the tab where a recording starts ("on-start").
 * The setting lives under its own storage key; the service worker keeps the dynamic registration
 * in line with it.
 */

export const CONTENT_INJECTION_MODES = ["always", "on-start"] as const;

export type ContentInjectionMode = (typeof CONTENT_INJECTION_MODES)[number];

export const CONTENT_INJECTION_STORAGE_KEY = "webblackbox.injection";
export const DEFAULT_CONTENT_INJECTION_MODE: ContentInjectionMode = "always";
export const CONTENT_SCRIPT_ID = "webblackbox-content";
export const CONTENT_SCRIPT_FILE = "content.js";

/** Set on `globalThis` of the isolated world by a running content script. */
export const CONTENT_SCRIPT_GUARD_KEY = "__webblackboxContentScript__";

export type ContentScriptRegistration = {
  id: string;
  matches: string[];
  js: string[];
  allFrames: boolean;
  runAt: "document_start";
  persistAcrossSessions: boolean;
};

export type RegistrationAction = "register" | "unregister" | "none";

export function isContentInjectionMode(value: unknown): value is ContentInjectionMode {
  return CONTENT_INJECTION_MODES.includes(value as ContentInjectionMode);
}

/** Stored value → mode; anything unknown falls back to the default. */
export function normalizeContentInjectionMode(value: unknown): ContentInjectionMode {
  return isContentInjectionMode(value) ? value : DEFAULT_CONTENT_INJECTION_MODE;
}

/** The all-sites registration that replaces the former static manifest entry. */
export function createContentScriptRegistration(): ContentScriptRegistration {
  return {
    id: CONTENT_SCRIPT_ID,
    matches: ["<all_urls>"],
    js: [CONTENT_SCRIPT_FILE],
    allFrames: true,
    runAt: "document_start",
    persistAcrossSessions: true
  };
}

/** What has to change so the registration matches `mode`, given the registered script ids. */
export function planContentScriptRegistration(
  mode: ContentInjectionMode,
  registeredIds: readonly string[]
): RegistrationAction {
  const registered = registeredIds.includes(CONTENT_SCRIPT_ID);

  if (mode === "always") {
    return registered ? "none" : "register";
  }

  return registered ? "unregister" : "none";
}
