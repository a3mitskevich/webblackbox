/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";

import {
  nextThemePreference,
  parseThemePreference,
  readThemePreference,
  resolveTheme,
  storeThemePreference,
  THEME_STORAGE_KEY
} from "./preferences.js";

afterEach(() => {
  window.localStorage.clear();
});

describe("theme preference", () => {
  it("parses, stores and cycles the preference", () => {
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("blue")).toBe("system");
    expect(parseThemePreference(null)).toBe("system");
    expect(readThemePreference()).toBe("system");

    storeThemePreference("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(readThemePreference()).toBe("light");

    expect(nextThemePreference("system")).toBe("light");
    expect(nextThemePreference("light")).toBe("dark");
    expect(nextThemePreference("dark")).toBe("system");
  });

  it("resolves the system theme from the OS setting", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});
