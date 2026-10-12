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
  query,
  resetPopupDom,
  stoppedSession
} from "./popup-test-harness.js";

/** Maximum picked by a site rule, as the service worker previews it. */
const PREVIEW = {
  kind: "sw.profile-preview",
  catalog: [
    { id: "builtin:maximum", name: "Maximum", base: "full", extended: true, readOnly: true },
    { id: "builtin:lite", name: "Light", base: "lite", extended: false, readOnly: true }
  ],
  selection: {
    id: "builtin:maximum",
    name: "Maximum",
    base: "full",
    source: "rule",
    ruleName: "Stage",
    extended: true,
    requiresFull: true,
    visual: "both"
  }
};

const DEFAULT_PREVIEW = {
  ...PREVIEW,
  selection: { ...PREVIEW.selection, source: "default", ruleName: undefined }
};

const has = (selector: string): boolean => document.querySelector(selector) !== null;

async function emitSessions(port: FakePort, sessions: unknown[]): Promise<void> {
  port.emit({ kind: "sw.session-list", sessions });
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

  it("shows one Record button and hides actions that do not apply while idle", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();

    expect(document.querySelectorAll("[data-action='start']")).toHaveLength(1);
    expect(getButton("start").textContent).toBe("Record");
    expect(has("[data-action='stop']")).toBe(false);
    expect(has("[data-action='marker']")).toBe(false);
    expect(has("[data-action='export']")).toBe(false);
    // No engine, visual capture or profile choice on the default path.
    expect(has("input[type='radio']")).toBe(false);
    expect(has("select")).toBe(false);
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

  it("keeps keyboard focus on the Record button across a re-render", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    getButton("start").focus();

    await emitSessions(port, [stoppedSession("sid-last")]);

    expect(document.activeElement).toBe(getButton("start"));
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
      { ...stoppedSession("sid-last", "full"), eventCount: 1843, profileName: "Team" }
    ]);

    expect(getButton("export").disabled).toBe(false);
    expect(query(".wb-popup__last").textContent).toContain("Team");
    expect(query(".wb-popup__last").textContent).toContain("1,843");
    // An export the user put off: Record is back next to it.
    expect(getButton("start").disabled).toBe(false);
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

  it("renders the recording panel without a ring buffer meter or inline styles", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    await emitSessions(port, [
      {
        ...activeSession("sid-current", "lite"),
        startedAt: Date.now() - 3 * 60 * 1000
      }
    ]);

    expect(document.querySelector(".wb-popup__live")).not.toBeNull();
    expect(document.querySelector("progress")).toBeNull();
    expect(document.body.textContent).not.toMatch(/ring buffer/i);
    expect(document.querySelector("[style]")).toBeNull();
  });
});

describe("popup recording profile line", () => {
  beforeEach(resetPopupDom);
  afterEach(cleanUp);

  it("asks the service worker which profile Record uses and names it", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();

    // No choice is sent: the site rules, else the default profile, decide.
    expect(port.postMessage).toHaveBeenCalledWith({ kind: "ui.resolve-profile", tabId: 17 });

    port.emit(DEFAULT_PREVIEW);
    await flushPopup();

    const line = query<HTMLElement>("[data-profile-line]");
    expect(line.textContent).toBe("Profile: Maximum · Change");
    expect(line.querySelector("[data-profile-name]")?.getAttribute("data-profile-name")).toBe(
      "builtin:maximum"
    );
  });

  it("says when a site rule picked the profile", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    port.emit(PREVIEW);
    await flushPopup();

    expect(query("[data-profile-line]").textContent).toBe(
      "Profile: Maximum (site rule “Stage”) · Change"
    );
  });

  it("shows a user profile under its own name", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();
    port.emit({
      ...PREVIEW,
      selection: { ...DEFAULT_PREVIEW.selection, id: "team", name: "Team" }
    });
    await flushPopup();

    expect(query("[data-profile-name]").textContent).toBe("Team");
  });

  it("opens the profiles in Options from Change", async () => {
    const port = new FakePort();
    const chrome = installChromeStub(port);
    vi.spyOn(window, "close").mockImplementation(() => undefined);

    await importPopupModule();
    port.emit(DEFAULT_PREVIEW);
    await flushPopup();
    query<HTMLButtonElement>("[data-profile-line] [data-action='open-profiles']").click();
    await flushPopup();

    expect(chrome.tabsCreate).toHaveBeenCalledWith({
      url: "chrome-extension://test-extension/options.html#profiles",
      active: true
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

    expect(query(".wb-popup__profile-capped").textContent).toBe(
      "Your organization's policy limits: console, network."
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
    // It takes the Record panel's place and look: a panel with one primary action.
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
          profileId: "qa",
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
      "To keep recording here with QA, add a site rule for this site or make it the default profile in Options → Profiles.",
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
