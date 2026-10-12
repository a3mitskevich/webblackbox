// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  activeSession,
  FakePort,
  flushPopup,
  getButton,
  getStatusLine,
  importPopupModule,
  installChromeStub,
  postedOfKind,
  query,
  resetPopupDom
} from "./popup-test-harness.js";

const START_RELOAD_OFFER_STORAGE_KEY = "webblackbox.startReloadOffer";

const has = (selector: string): boolean => document.querySelector(selector) !== null;

async function clickRecord(): Promise<void> {
  getButton("start").click();
  await flushPopup();
}

/** Record, then "Record Without Reload" in the question Record asks by default. */
async function recordWithoutReload(): Promise<void> {
  await clickRecord();
  getButton("start-direct").click();
  await flushPopup();
}

describe("popup Record", () => {
  beforeEach(resetPopupDom);

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "chrome");
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("asks about the reload by default, with Reload and Record as the main choice", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    await clickRecord();

    expect(has(".wb-confirm-overlay")).toBe(true);
    expect(getButton("start-reload").textContent).toBe("Reload and Record");
    expect(getButton("start-reload").type).toBe("submit");
    expect(document.activeElement).toBe(getButton("start-reload"));
    expect(has("[data-choice-remember]")).toBe(true);
    expect(postedOfKind(port, "ui.start")).toEqual([]);

    getButton("start-reload").click();
    await flushPopup();

    // The profile decides the engine and what is captured: no mode, profile or visuals here.
    expect(postedOfKind(port, "ui.start")).toEqual([
      { kind: "ui.start", tabId: 17, reloadPage: true }
    ]);
    expect(has(".wb-confirm-overlay")).toBe(false);
  });

  it("can record without reloading", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    await recordWithoutReload();

    expect(postedOfKind(port, "ui.start")).toEqual([{ kind: "ui.start", tabId: 17 }]);
  });

  it("does not start or remember anything when the reload question is cancelled", async () => {
    const port = new FakePort();
    const chrome = installChromeStub(port, { storage: {} });

    await importPopupModule();
    await clickRecord();
    query<HTMLInputElement>("[data-choice-remember]").click();
    getButton("start-cancel").click();
    await flushPopup();

    expect(postedOfKind(port, "ui.start")).toEqual([]);
    expect(chrome.storageSet).not.toHaveBeenCalled();
    expect(has(".wb-confirm-overlay")).toBe(false);
  });

  it.each([
    ["start-reload", "always", { kind: "ui.start", tabId: 17, reloadPage: true }],
    ["start-direct", "never", { kind: "ui.start", tabId: 17 }]
  ] as const)(
    "stores %s with Don't ask again as %s and starts",
    async (action, stored, expected) => {
      const port = new FakePort();
      const chrome = installChromeStub(port, { storage: {} });

      await importPopupModule();
      await clickRecord();
      query<HTMLInputElement>("[data-choice-remember]").click();
      getButton(action).click();
      await flushPopup();

      expect(chrome.storageSet).toHaveBeenCalledWith({ [START_RELOAD_OFFER_STORAGE_KEY]: stored });
      expect(postedOfKind(port, "ui.start")).toEqual([expected]);
    }
  );

  it("stores nothing when Don't ask again stays unticked", async () => {
    const port = new FakePort();
    const chrome = installChromeStub(port, { storage: {} });

    await importPopupModule();
    await recordWithoutReload();

    expect(chrome.storageSet).not.toHaveBeenCalled();
  });

  it.each([
    ["always", { kind: "ui.start", tabId: 17, reloadPage: true }],
    ["never", { kind: "ui.start", tabId: 17 }],
    // Earlier versions stored a switch; off started without a reload.
    [false, { kind: "ui.start", tabId: 17 }]
  ] as const)("starts at once for the stored choice %j", async (stored, expected) => {
    const port = new FakePort();
    installChromeStub(port, { storage: { [START_RELOAD_OFFER_STORAGE_KEY]: stored } });

    await importPopupModule();
    await clickRecord();

    expect(has(".wb-confirm-overlay")).toBe(false);
    expect(postedOfKind(port, "ui.start")).toEqual([expected]);
  });

  it.each(["ask", true])("asks for the stored choice %j", async (stored) => {
    const port = new FakePort();
    installChromeStub(port, { storage: { [START_RELOAD_OFFER_STORAGE_KEY]: stored } });

    await importPopupModule();
    await clickRecord();

    expect(has(".wb-confirm-overlay")).toBe(true);
  });

  it("keeps Record disabled while the start request is pending", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    await recordWithoutReload();

    expect(getButton("start").disabled).toBe(true);
    expect(getButton("start").textContent).toBe("Starting…");

    port.emit({ kind: "sw.session-list", sessions: [] });
    await flushPopup();

    expect(getButton("start").disabled).toBe(true);

    // Whatever engine the profile started in.
    port.emit({ kind: "sw.session-list", sessions: [activeSession("sid-started", "lite")] });
    await flushPopup();

    expect(has("[data-action='start']")).toBe(false);
  });

  it("reports a start failure", async () => {
    const port = new FakePort();
    installChromeStub(port, {
      sendMessage: vi.fn(async () => ({ ok: false, error: "Debugger is already attached" }))
    });

    await importPopupModule();
    await recordWithoutReload();

    expect(getStatusLine().textContent).toBe("Start failed: Debugger is already attached");
    expect(getButton("start").disabled).toBe(false);
  });
});
