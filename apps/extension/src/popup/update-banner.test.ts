// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EXTENSION_UPDATE_DISMISSED_STORAGE_KEY,
  EXTENSION_UPDATE_STORAGE_KEY
} from "../shared/extension-update.js";
import {
  FakePort,
  flushPopup,
  getButton,
  importPopupModule,
  installChromeStub,
  resetPopupDom
} from "./popup-test-harness.js";

// The stub's installed version is 0.1.1.
const NEWER = {
  latestVersion: "0.2.0",
  checkedAt: 1_760_000_000_000,
  playerUrl: "https://player.example.com/qa/"
};

const banner = () => document.querySelector<HTMLElement>("[data-update-notice]");

function storageSet(): ReturnType<typeof vi.fn> {
  return (
    globalThis as unknown as { chrome: { storage: { local: { set: ReturnType<typeof vi.fn> } } } }
  ).chrome.storage.local.set;
}

describe("popup update banner", () => {
  beforeEach(() => {
    resetPopupDom();
    vi.spyOn(window, "close").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "chrome");
  });

  it("shows the newer version and opens the Player in a new tab", async () => {
    const chrome = installChromeStub(new FakePort(), {
      storage: { [EXTENSION_UPDATE_STORAGE_KEY]: NEWER }
    });

    await importPopupModule();

    expect(banner()?.textContent).toContain("Version 0.2.0 is available (you have 0.1.1).");
    getButton("open-update-guide").click();
    await flushPopup();

    expect(chrome.tabsCreate).toHaveBeenCalledWith({
      url: "https://player.example.com/qa/",
      active: true
    });
  });

  it("hides the banner for that version when dismissed", async () => {
    installChromeStub(new FakePort(), { storage: { [EXTENSION_UPDATE_STORAGE_KEY]: NEWER } });

    await importPopupModule();
    getButton("dismiss-update").click();
    await flushPopup();

    expect(storageSet()).toHaveBeenCalledWith({
      [EXTENSION_UPDATE_DISMISSED_STORAGE_KEY]: "0.2.0"
    });
    expect(banner()).toBeNull();
  });

  it.each([
    ["no known version", {}],
    ["the same version", { [EXTENSION_UPDATE_STORAGE_KEY]: { ...NEWER, latestVersion: "0.1.1" } }],
    [
      "a dismissed version",
      { [EXTENSION_UPDATE_STORAGE_KEY]: NEWER, [EXTENSION_UPDATE_DISMISSED_STORAGE_KEY]: "0.2.0" }
    ]
  ])("shows nothing for %s", async (_label, storage) => {
    installChromeStub(new FakePort(), { storage });

    await importPopupModule();

    expect(banner()).toBeNull();
  });

  it("disables the Player button for a stored URL that is not https or loopback", async () => {
    const chrome = installChromeStub(new FakePort(), {
      storage: { [EXTENSION_UPDATE_STORAGE_KEY]: { ...NEWER, playerUrl: "javascript:alert(1)" } }
    });

    await importPopupModule();
    const open = getButton("open-update-guide");
    open.click();
    await flushPopup();

    expect(open.disabled).toBe(true);
    expect(chrome.tabsCreate).not.toHaveBeenCalled();
  });
});
