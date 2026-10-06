import { readStoredText, writeStoredText } from "../lib/storage.js";

/** Theme choice: follow the OS (default), or a fixed light / dark theme. */
export type ThemePreference = "system" | "light" | "dark";

export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "webblackbox.player.theme";

const THEME_ORDER: readonly ThemePreference[] = ["system", "light", "dark"];

export function parseThemePreference(raw: string | null | undefined): ThemePreference {
  return raw === "light" || raw === "dark" ? raw : "system";
}

export function readThemePreference(): ThemePreference {
  return parseThemePreference(readStoredText(THEME_STORAGE_KEY));
}

export function storeThemePreference(preference: ThemePreference): void {
  writeStoredText(THEME_STORAGE_KEY, preference);
}

/** The theme toggle cycles system → light → dark → system. */
export function nextThemePreference(preference: ThemePreference): ThemePreference {
  const index = THEME_ORDER.indexOf(preference);
  return THEME_ORDER[(index + 1) % THEME_ORDER.length] ?? "system";
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === "system") {
    return prefersDark ? "dark" : "light";
  }

  return preference;
}
