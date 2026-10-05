import { afterEach, describe, expect, it, vi } from "vitest";

import { EXTENSION_LOCALE_STORAGE_KEY } from "../shared/i18n.js";
import { loadKeyboardMarkerLabel } from "./content-agent.js";

function installChrome(options: { uiLanguage: string; stored?: string }): void {
  const data =
    options.stored === undefined ? {} : { [EXTENSION_LOCALE_STORAGE_KEY]: options.stored };

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    writable: true,
    value: {
      i18n: { getUILanguage: () => options.uiLanguage },
      storage: { local: { get: vi.fn(async () => ({ ...data })) } }
    }
  });
}

describe("loadKeyboardMarkerLabel", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "chrome");
  });

  it("uses the language chosen in Options", async () => {
    installChrome({ uiLanguage: "en-US", stored: "ru" });

    await expect(loadKeyboardMarkerLabel()).resolves.toBe("Маркер с клавиатуры");
  });

  it("follows Chrome's language on Auto", async () => {
    installChrome({ uiLanguage: "en-US", stored: "auto" });

    await expect(loadKeyboardMarkerLabel()).resolves.toBe("Keyboard marker");
  });
});
