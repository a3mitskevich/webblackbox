import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"]
  });
  return () => observer.disconnect();
}

const readTheme = (): string => document.documentElement.dataset.theme ?? "";
const readServerTheme = (): string => "";

/**
 * The resolved theme (`light` / `dark`) that `useThemeAttribute` writes to `data-theme` on <html>:
 * unlike the preference, it also changes when the OS scheme flips under "system".
 */
export function useDocumentTheme(): string {
  return useSyncExternalStore(subscribe, readTheme, readServerTheme);
}
