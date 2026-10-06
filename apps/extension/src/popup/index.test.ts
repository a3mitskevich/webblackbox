// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  activeSession,
  chooseRadio,
  FakePort,
  flushPopup,
  getButton,
  getStatusLine,
  importPopupModule,
  installChromeStub,
  query,
  resetPopupDom,
  stoppedSession
} from "./popup-test-harness.js";

const POPUP_FULL_VISUAL_CAPTURE_STORAGE_KEY = "webblackbox.popup.full-visual-capture";

const PREVIEW = {
  kind: "sw.profile-preview",
  catalog: [
    { id: "default", name: "Default", base: "lite", extended: false, readOnly: false },
    { id: "builtin:qa", name: "QA", base: "full", extended: true, readOnly: true }
  ],
  selection: {
    id: "builtin:qa",
    name: "QA",
    base: "full",
    source: "rule",
    ruleName: "Stage",
    extended: true,
    requiresFull: true
  }
};

/** A profile that works in both engines (base Full): the engine switch stays free. */
const BOTH_ENGINES_PREVIEW = {
  ...PREVIEW,
  catalog: [
    ...PREVIEW.catalog,
    { id: "builtin:full", name: "Full", base: "full", extended: false, readOnly: true }
  ],
  selection: {
    id: "builtin:full",
    name: "Full",
    base: "full",
    source: "explicit",
    extended: false,
    requiresFull: false
  }
};

const DEFAULT_PREVIEW = {
  ...PREVIEW,
  selection: {
    id: "default",
    name: "Default",
    base: "lite",
    source: "default",
    extended: false,
    requiresFull: false
  }
};

const has = (selector: string): boolean => document.querySelector(selector) !== null;
const radio = (name: string, value: string): HTMLInputElement =>
  query<HTMLInputElement>(`input[name='${name}'][value='${value}']`);

async function emitSessions(port: FakePort, sessions: unknown[]): Promise<void> {
  port.emit({ kind: "sw.session-list", sessions });
  await flushPopup();
}

async function chooseFullEngine(): Promise<void> {
  chooseRadio("capture-mode", "full");
  await flushPopup();
}

function cleanUp(): void {
  vi.restoreAllMocks();
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "chrome");
  document.body.innerHTML = "";
  localStorage.clear();
}

describe("popup states", () => {
  beforeEach(resetPopupDom);
  afterEach(cleanUp);

  it("shows one Start button and hides actions that do not apply while idle", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();

    expect(has("[data-action='start']")).toBe(true);
    expect(has("[data-action='stop']")).toBe(false);
    expect(has("[data-action='marker']")).toBe(false);
    expect(has("[data-action='export']")).toBe(false);
    expect(radio("capture-mode", "lite").checked).toBe(true);
    expect(has("input[name='full-visual-capture']")).toBe(false);
    expect(query(".wb-popup__title").textContent).toBe("WebBlackbox");
    expect(document.body.textContent).toContain("Idle");
  });

  it("swaps Start for Stop, Marker and counters while the current tab records", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    await emitSessions(port, [
      { ...activeSession("sid-current", "lite"), eventCount: 42, errorCount: 2, sizeBytes: 2048 }
    ]);

    expect(has("[data-action='start']")).toBe(false);
    expect(has("[data-action='export']")).toBe(false);
    expect(getButton("stop").disabled).toBe(false);
    expect(has("[data-action='marker']")).toBe(true);
    expect(query(".wb-popup__live .wb-stats").textContent).toContain("42");
    expect(query(".wb-badge").textContent).toBe("REC");

    await emitSessions(port, [activeSession("sid-other", "full", 42)]);

    expect(getButton("start").disabled).toBe(false);
    expect(query(".wb-popup__live").textContent).toContain("Recording on tab 42");
    // The other tab's recording is one row so Start and the last session still fit.
    expect(has(".wb-popup__live .wb-stats")).toBe(false);
    expect(has("[data-action='marker']")).toBe(false);
    expect(getButton("stop").disabled).toBe(false);
  });

  it("refreshes active session state when reopening after the initial connect push was missed", async () => {
    const sessions = [activeSession("sid-full-active", "full")];
    const port = new FakePort((message, currentPort) => {
      if ((message as { kind?: unknown }).kind === "ui.request-session-list") {
        currentPort.emit({ kind: "sw.session-list", sessions });
      }
    });
    installChromeStub(port, {
      onQuery: () => port.emit({ kind: "sw.session-list", sessions })
    });

    await importPopupModule();

    expect(port.postMessage).toHaveBeenCalledWith({ kind: "ui.request-session-list" });
    expect(has("[data-action='start']")).toBe(false);
    expect(getButton("stop").disabled).toBe(false);
    expect(document.body.textContent).toContain("Recording (Full)");
  });

  it("stops the recording session from the popup", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    await emitSessions(port, [activeSession("sid-stop", "full", 17)]);
    getButton("stop").click();

    expect(port.postMessage).toHaveBeenCalledWith({ kind: "ui.stop", tabId: 17 });
  });

  it("reports a lost service worker connection instead of a silent Stop", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    await emitSessions(port, [activeSession("sid-stop", "full", 17)]);
    port.disconnect();
    await flushPopup();
    port.postMessage.mockClear();
    getButton("stop").click();
    await flushPopup();

    expect(port.postMessage).not.toHaveBeenCalled();
    expect(getStatusLine().textContent).toContain("Lost the connection");
    expect(getStatusLine().classList.contains("wb-popup__status--error")).toBe(true);
  });

  it("keeps keyboard focus on the engine switch across the re-render it causes", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    radio("capture-mode", "full").focus();
    await chooseFullEngine();

    expect(document.activeElement).toBe(radio("capture-mode", "full"));
    expect(radio("capture-mode", "full").checked).toBe(true);

    await emitSessions(port, [stoppedSession("sid-last")]);

    expect(document.activeElement).toBe(radio("capture-mode", "full"));
  });

  it("announces status changes through one persistent live region", async () => {
    const port = new FakePort();
    installChromeStub(port, { tabsSendMessage: vi.fn(async () => undefined) });

    await importPopupModule();
    const live = query<HTMLElement>("[data-popup-live]");
    await emitSessions(port, [activeSession("sid-marker", "full", 17)]);
    getButton("marker").click();
    await flushPopup();

    expect(query<HTMLElement>("[data-popup-live]")).toBe(live);
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toBe(getStatusLine().textContent);
    expect(live.textContent).not.toBe("");
    expect(document.querySelectorAll("[role='status']")).toHaveLength(1);
  });

  it("adds a marker through the tab's content script", async () => {
    const port = new FakePort();
    const stub = installChromeStub(port);

    await importPopupModule();
    await emitSessions(port, [activeSession("sid-marker", "full", 17)]);
    getButton("marker").click();
    await flushPopup();

    expect(stub.tabsSendMessage).toHaveBeenCalledWith(17, { kind: "sw.marker-command" });
    expect(getStatusLine().textContent).toBe("Marker added.");
  });

  it("reports a marker failure", async () => {
    const port = new FakePort();
    installChromeStub(port, {
      tabsSendMessage: vi.fn(async () => {
        throw new Error("Receiving end does not exist.");
      })
    });

    await importPopupModule();
    await emitSessions(port, [activeSession("sid-marker", "full", 17)]);
    getButton("marker").click();
    await flushPopup();

    expect(getStatusLine().textContent).toBe("Marker failed: Receiving end does not exist.");
    expect(getStatusLine().classList.contains("wb-popup__status--error")).toBe(true);
  });

  it("offers Export for the last stopped session", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    await emitSessions(port, [
      { ...stoppedSession("sid-last", "full"), eventCount: 1843, profileName: "QA" }
    ]);

    expect(getButton("export").disabled).toBe(false);
    expect(query(".wb-popup__last").textContent).toContain("QA");
    expect(query(".wb-popup__last").textContent).toContain("1,843");
  });

  it("opens the sessions and options pages from the header icons", async () => {
    const port = new FakePort();
    const stub = installChromeStub(port);
    const windowClose = vi.spyOn(window, "close").mockImplementation(() => undefined);

    await importPopupModule();

    expect(getButton("open-sessions").getAttribute("aria-label")).toBe("Sessions");
    expect(getButton("open-options").getAttribute("aria-label")).toBe("Options");
    getButton("open-sessions").click();
    getButton("open-options").click();
    await flushPopup();

    expect(stub.tabsCreate).toHaveBeenNthCalledWith(1, {
      url: "chrome-extension://test-extension/sessions.html",
      active: true
    });
    expect(stub.tabsCreate).toHaveBeenNthCalledWith(2, {
      url: "chrome-extension://test-extension/options.html",
      active: true
    });
    expect(windowClose).toHaveBeenCalledTimes(2);
  });

  it("renders the ring buffer meter without inline styles", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    await emitSessions(port, [
      {
        ...activeSession("sid-current", "lite"),
        startedAt: Date.now() - 3 * 60 * 1000,
        ringBufferMinutes: 10
      }
    ]);

    const meter = document.querySelector<HTMLProgressElement>("progress.wb-popup__buffer-meter");

    expect(meter?.value).toBeGreaterThan(0);
    expect(document.querySelector("[style]")).toBeNull();
  });
});

describe("popup start", () => {
  beforeEach(resetPopupDom);
  afterEach(cleanUp);

  it("asks before starting lite with a page reload", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    getButton("start").click();
    await flushPopup();

    expect(has(".wb-confirm-overlay")).toBe(true);
    expect(getButton("start-lite-reload").textContent).toBe("Reload and Start Lite");
    expect(port.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ui.start" })
    );

    getButton("start-lite-reload").click();
    await flushPopup();

    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "ui.start",
      tabId: 17,
      mode: "lite",
      reloadPage: true
    });
    expect(has(".wb-confirm-overlay")).toBe(false);
  });

  it("can start lite without reloading", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    getButton("start").click();
    await flushPopup();
    getButton("start-lite-direct").click();
    await flushPopup();

    expect(port.postMessage).toHaveBeenCalledWith({ kind: "ui.start", tabId: 17, mode: "lite" });
  });

  it("does not start lite when the reload confirmation is cancelled", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    getButton("start").click();
    await flushPopup();
    getButton("start-lite-cancel").click();
    await flushPopup();

    expect(port.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ui.start" })
    );
    expect(has(".wb-confirm-overlay")).toBe(false);
  });

  it("keeps Start disabled while a full start request is pending", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    await chooseFullEngine();
    getButton("start").click();
    await flushPopup();

    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "ui.start",
      tabId: 17,
      mode: "full",
      visualCapture: "screenshots"
    });
    expect(getButton("start").disabled).toBe(true);
    expect(getButton("start").textContent).toBe("Starting…");

    await emitSessions(port, []);

    expect(getButton("start").disabled).toBe(true);

    await emitSessions(port, [activeSession("sid-started", "full")]);

    expect(has("[data-action='start']")).toBe(false);
  });

  it.each([
    ["recording", "recording"],
    ["both", "both"],
    ["none", "none"]
  ] as const)("starts full mode with %s visual capture", async (choice, expected) => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    await chooseFullEngine();

    expect(radio("full-visual-capture", "screenshots").checked).toBe(true);

    chooseRadio("full-visual-capture", choice);
    getButton("start").click();
    await flushPopup();

    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "ui.start",
      tabId: 17,
      mode: "full",
      visualCapture: expected
    });
  });

  it("preserves the full visual capture choice across popup reopen", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    await chooseFullEngine();
    chooseRadio("full-visual-capture", "recording");

    expect(localStorage.getItem(POPUP_FULL_VISUAL_CAPTURE_STORAGE_KEY)).toBe("recording");

    document.body.innerHTML = `<main id="popup-root"></main>`;
    installChromeStub(new FakePort());
    await importPopupModule();
    await chooseFullEngine();

    expect(radio("full-visual-capture", "recording").checked).toBe(true);
  });

  it("reports a start failure", async () => {
    const port = new FakePort();
    installChromeStub(port, {
      sendMessage: vi.fn(async () => ({ ok: false, error: "Debugger is already attached" }))
    });

    await importPopupModule();
    await chooseFullEngine();
    getButton("start").click();
    await flushPopup();

    expect(getStatusLine().textContent).toBe("Start failed: Debugger is already attached");
    expect(getButton("start").disabled).toBe(false);
  });
});

describe("popup recording profiles", () => {
  beforeEach(resetPopupDom);
  afterEach(cleanUp);

  const getProfileSelect = (): HTMLSelectElement =>
    query<HTMLSelectElement>("[data-profile-select]");

  it("asks the service worker for the rule-selected profile and explains it", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();

    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "ui.resolve-profile",
      tabId: 17,
      profileId: "auto"
    });

    port.emit(PREVIEW);
    await flushPopup();

    expect([...getProfileSelect().options].map((option) => option.textContent)).toEqual([
      "Auto (site rules)",
      "Default",
      "QA · extended"
    ]);
    expect(query("[data-profile-hint]").textContent).toBe(
      "Records with QA (rule: Stage). Full only: Lite cannot capture what this profile records."
    );
  });

  it("defaults the engine to the profile's recommendation until the user picks one", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    port.emit(BOTH_ENGINES_PREVIEW);
    await flushPopup();

    expect(radio("capture-mode", "full").checked).toBe(true);

    chooseRadio("capture-mode", "lite");
    await flushPopup();
    port.emit(BOTH_ENGINES_PREVIEW);
    await flushPopup();

    expect(radio("capture-mode", "lite").checked).toBe(true);

    const select = getProfileSelect();
    select.value = "builtin:full";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    port.emit(BOTH_ENGINES_PREVIEW);
    await flushPopup();

    expect(radio("capture-mode", "full").checked).toBe(true);
  });

  it("locks the engine to Full for a profile that needs it and says why", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    port.emit(PREVIEW);
    await flushPopup();

    expect(radio("capture-mode", "full").checked).toBe(true);
    expect(radio("capture-mode", "full").disabled).toBe(true);
    expect(radio("capture-mode", "lite").disabled).toBe(true);
    expect(query("[data-profile-hint]").textContent).toContain("Full only:");
  });

  it("keeps the engine switch for a profile that works in both engines", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    port.emit(DEFAULT_PREVIEW);
    await flushPopup();

    expect(radio("capture-mode", "lite").checked).toBe(true);
    expect(radio("capture-mode", "lite").disabled).toBe(false);
    expect(radio("capture-mode", "full").disabled).toBe(false);
    expect(query("[data-profile-hint]").textContent).toContain("Recommended start: Lite.");
  });

  it("starts in Full for a profile that needs it, ignoring Lite picked before", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    port.emit(DEFAULT_PREVIEW);
    await flushPopup();
    chooseRadio("capture-mode", "lite");
    await flushPopup();
    // The site rules now pick QA for the tab (e.g. after a navigation); the Lite pick is stale.
    port.emit(PREVIEW);
    await flushPopup();

    getButton("start").click();
    await flushPopup();

    expect(has("[role='dialog']")).toBe(false);
    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "ui.start",
      tabId: 17,
      mode: "full",
      visualCapture: "screenshots"
    });
  });

  it("shows the visual capture a profile pins instead of the choice", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    port.emit({ ...PREVIEW, selection: { ...PREVIEW.selection, visual: "both" } });
    await flushPopup();

    expect(has("input[name='full-visual-capture']")).toBe(false);
    expect(document.body.textContent).toContain("Visual capture: Both (set by the profile).");
  });

  it("starts with an explicitly chosen profile and remembers the choice", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    port.emit(PREVIEW);
    await flushPopup();

    const select = getProfileSelect();
    select.value = "builtin:qa";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flushPopup();

    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "ui.resolve-profile",
      tabId: 17,
      profileId: "builtin:qa"
    });
    expect(localStorage.getItem("webblackbox.popup.profile-choice")).toBe("builtin:qa");

    port.emit(PREVIEW);
    await flushPopup();
    getButton("start").click();
    await flushPopup();

    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "ui.start",
      tabId: 17,
      mode: "full",
      profileId: "builtin:qa",
      visualCapture: "screenshots"
    });
  });

  it("names the categories the enterprise policy caps", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    port.emit({
      ...PREVIEW,
      selection: { ...PREVIEW.selection, enterpriseCapped: ["console", "network"] }
    });
    await flushPopup();

    expect(query("[data-profile-hint]").textContent).toBe(
      "Records with QA (rule: Stage). Your organization's policy limits: console, network. Full only: Lite cannot capture what this profile records."
    );
  });

  it("requires a profile when every profile was deleted and links to the profiles page", async () => {
    const port = new FakePort();
    const chrome = installChromeStub(port);
    vi.spyOn(window, "close").mockImplementation(() => undefined);

    await importPopupModule();

    expect(has("[data-profile-required]")).toBe(false);

    port.emit({ kind: "sw.profile-preview", catalog: [], selection: null });
    await flushPopup();

    expect(query("[data-profile-required]").textContent).toBe(
      "No recording profile" +
        "Recording needs at least one profile. Restore the recommended profiles or import yours in Options." +
        "Open profiles"
    );
    expect(has("[data-action='start']")).toBe(false);
    // It takes the Start panel's place and look: a panel with one primary action.
    expect(query("[data-profile-required]").classList.contains("wb-panel")).toBe(true);
    expect(
      query("[data-profile-required] [data-action='open-profiles']").classList.contains(
        "wb-btn--brand"
      )
    ).toBe(true);

    query<HTMLButtonElement>("[data-profile-required] [data-action='open-profiles']").click();
    await flushPopup();

    expect(chrome.tabsCreate).toHaveBeenCalledWith({
      url: "chrome-extension://test-extension/options.html#profiles",
      active: true
    });
  });

  it("explains a recording stopped by a profile change and acknowledges it", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    port.emit(PREVIEW);
    port.emit({
      kind: "sw.session-list",
      sessions: [
        {
          ...stoppedSession("sid-cancelled"),
          startedAt: Date.now() - 5_000,
          stoppedAt: Date.now(),
          profileName: "QA",
          profileCancel: {
            reason: "rule-changed",
            at: Date.now(),
            startedName: "QA",
            nextName: "Default"
          }
        }
      ]
    });
    await flushPopup();

    const notice = query<HTMLElement>("[data-profile-cancel]");

    expect(notice.getAttribute("role")).toBe("alert");
    expect([...notice.querySelectorAll("strong, p")].map((node) => node.textContent)).toEqual([
      "Recording stopped: the profile changed",
      "It recorded with QA, but the site rules pick Default for this page.",
      "To keep recording here with QA, choose it in the profile list instead of Auto, or add a site rule for this site in Options → Profiles.",
      "What was recorded before the change is kept: export or delete it."
    ]);
    expect(getButton("export").disabled).toBe(false);
    expect(getButton("start").disabled).toBe(false);

    notice.querySelector<HTMLButtonElement>("[data-action='ack-profile-cancel']")?.click();
    await flushPopup();

    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "ui.ack-profile-cancel",
      sid: "sid-cancelled"
    });
  });
});
