// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const POPUP_EXPORT_POLICY_STORAGE_KEY = "webblackbox.popup.export-policy";
const POPUP_FULL_VISUAL_CAPTURE_STORAGE_KEY = "webblackbox.popup.full-visual-capture";
const EXPORT_PRIVACY_WARNING = {
  findingCount: 2,
  summary: "email in event:E-1, jwt in event:E-2",
  findings: [
    {
      kind: "email",
      path: "event:E-1",
      matchCount: 1
    },
    {
      kind: "jwt",
      path: "event:E-2",
      matchCount: 1
    }
  ]
};

type PortMessageHandler = (message: unknown) => void;
type PortPostMessageHandler = (message: unknown, port: FakePort) => void;

class FakePort {
  name = "webblackbox:popup";
  readonly postMessage: ReturnType<typeof vi.fn>;
  private readonly messageHandlers = new Set<PortMessageHandler>();

  constructor(onPostMessage?: PortPostMessageHandler) {
    this.postMessage = vi.fn((message: unknown) => {
      onPostMessage?.(message, this);
    });
  }

  readonly onMessage = {
    addListener: (handler: PortMessageHandler): void => {
      this.messageHandlers.add(handler);
    },
    removeListener: (handler: PortMessageHandler): void => {
      this.messageHandlers.delete(handler);
    }
  };

  readonly onDisconnect = {
    addListener: (): void => {
      void 0;
    },
    removeListener: (): void => {
      void 0;
    }
  };

  emit(message: unknown): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }
}

function installChromeStub(
  port: FakePort,
  options: {
    sendMessage?: ReturnType<typeof vi.fn>;
    onQuery?: () => void | Promise<void>;
  } = {}
): void {
  const query = vi.fn(async () => {
    await options.onQuery?.();
    return [
      {
        id: 17,
        active: true,
        url: "https://example.com",
        lastAccessed: Date.now()
      }
    ];
  });
  const create = vi.fn(async (details: { url?: string; active?: boolean }) => ({
    id: 99,
    active: details.active ?? true,
    url: details.url
  }));
  const getURL = vi.fn((path: string) => `chrome-extension://test-extension/${path}`);

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    writable: true,
    value: {
      runtime: {
        connect: vi.fn(() => port),
        getURL,
        getManifest: vi.fn(() => ({
          version: "0.1.1"
        })),
        ...(options.sendMessage ? { sendMessage: options.sendMessage } : {})
      },
      tabs: {
        create,
        query
      }
    }
  });
}

async function flushPopup(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushPopupWithFakeTimers(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
}

function getMaxArchiveInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>("#export-max-size-mb");

  if (!input) {
    throw new Error("missing max archive input");
  }

  return input;
}

function getRecentMinutesInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>("#export-recent-minutes");

  if (!input) {
    throw new Error("missing recent minutes input");
  }

  return input;
}

function getExportButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>("[data-action='export']");

  if (!button) {
    throw new Error("missing export button");
  }

  return button;
}

function getStatusLine(): HTMLElement {
  const status = document.querySelector<HTMLElement>(".wb-popup__status");

  if (!status) {
    throw new Error("missing status line");
  }

  return status;
}

function getStartLiteButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>("[data-action='start-lite']");

  if (!button) {
    throw new Error("missing start lite button");
  }

  return button;
}

function getStartFullButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>("[data-action='start-full']");

  if (!button) {
    throw new Error("missing start full button");
  }

  return button;
}

function getStopButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>("[data-action='stop']");

  if (!button) {
    throw new Error("missing stop button");
  }

  return button;
}

function getFullVisualCaptureRadio(
  value: "screenshots" | "recording" | "both" | "none"
): HTMLInputElement {
  const radio = document.querySelector<HTMLInputElement>(
    `input[name='full-visual-capture'][value='${value}']`
  );

  if (!radio) {
    throw new Error(`missing full visual capture radio: ${value}`);
  }

  return radio;
}

function getLiteReloadStartButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>("[data-action='start-lite-reload']");

  if (!button) {
    throw new Error("missing lite reload start button");
  }

  return button;
}

function getLiteDirectStartButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>("[data-action='start-lite-direct']");

  if (!button) {
    throw new Error("missing lite direct start button");
  }

  return button;
}

function getLiteStartCancelButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>("[data-action='start-lite-cancel']");

  if (!button) {
    throw new Error("missing lite start cancel button");
  }

  return button;
}

function getSessionsButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>("[data-action='open-sessions']");

  if (!button) {
    throw new Error("missing sessions button");
  }

  return button;
}

function getOptionsButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>("[data-action='open-options']");

  if (!button) {
    throw new Error("missing options button");
  }

  return button;
}

function enterPassphrase(value: string): void {
  const input = document.querySelector<HTMLInputElement>("#wb-passphrase-input");

  if (!input) {
    throw new Error("missing passphrase input");
  }

  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function getPassphraseSubmitButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>("[data-passphrase-submit]");

  if (!button) {
    throw new Error("missing passphrase submit button");
  }

  return button;
}

async function importPopupModule(): Promise<void> {
  vi.resetModules();
  await import("./index.js");
  await flushPopup();
}

async function importPopupModuleWithFakeTimers(): Promise<void> {
  vi.resetModules();
  await import("./index.js");
  await flushPopupWithFakeTimers();
}

describe("popup export policy form", () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="popup-root"></main>`;
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    Reflect.deleteProperty(globalThis, "chrome");
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("preserves archive policy draft fields across popup rerenders and reopen", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();

    const maxArchiveMb = getMaxArchiveInput();
    const recentMinutes = getRecentMinutesInput();

    expect(document.querySelector("#export-include-screenshots")).toBeNull();
    expect(document.querySelector("#export-include-screen-recordings")).toBeNull();
    // Scanner findings are always shown inline: there is no alert toggle.
    expect(document.querySelector("#export-alert-sensitive-findings")).toBeNull();

    maxArchiveMb.value = "256";
    maxArchiveMb.dispatchEvent(new Event("input", { bubbles: true }));

    recentMinutes.value = "45";
    recentMinutes.dispatchEvent(new Event("input", { bubbles: true }));

    port.emit({
      kind: "sw.session-list",
      sessions: []
    });
    await flushPopup();

    expect(document.querySelector("#export-include-screenshots")).toBeNull();
    expect(document.querySelector("#export-include-screen-recordings")).toBeNull();
    expect(getMaxArchiveInput().value).toBe("256");
    expect(getRecentMinutesInput().value).toBe("45");
    expect(JSON.parse(localStorage.getItem(POPUP_EXPORT_POLICY_STORAGE_KEY) ?? "null")).toEqual({
      maxArchiveMb: "256",
      recentMinutes: "45"
    });

    document.body.innerHTML = `<main id="popup-root"></main>`;
    installChromeStub(new FakePort());
    await importPopupModule();

    expect(document.querySelector("#export-include-screenshots")).toBeNull();
    expect(document.querySelector("#export-include-screen-recordings")).toBeNull();
    expect(getMaxArchiveInput().value).toBe("256");
    expect(getRecentMinutesInput().value).toBe("45");
  });

  it("exports archive limits with visual policy from the full capture selection", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();

    port.emit({
      kind: "sw.session-list",
      sessions: [
        {
          sid: "sid-1",
          tabId: 17,
          mode: "full",
          startedAt: Date.now(),
          active: false
        }
      ]
    });
    await flushPopup();

    const recording = getFullVisualCaptureRadio("recording");
    recording.checked = true;
    recording.dispatchEvent(new Event("change", { bubbles: true }));

    const maxArchiveMb = getMaxArchiveInput();
    maxArchiveMb.value = "256";
    maxArchiveMb.dispatchEvent(new Event("input", { bubbles: true }));

    const recentMinutes = getRecentMinutesInput();
    recentMinutes.value = "45";
    recentMinutes.dispatchEvent(new Event("input", { bubbles: true }));

    getExportButton().click();
    await flushPopup();

    const promptForm = document.querySelector<HTMLFormElement>("form.wb-prompt-card");

    if (!promptForm) {
      throw new Error("missing export prompt");
    }

    const passphraseInput = document.querySelector<HTMLInputElement>("#wb-passphrase-input");

    if (!passphraseInput) {
      throw new Error("missing passphrase input");
    }

    passphraseInput.value = " export-secret ";
    passphraseInput.dispatchEvent(new Event("input", { bubbles: true }));
    getPassphraseSubmitButton().click();
    await flushPopup();

    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "ui.export",
      sid: "sid-1",
      passphrase: " export-secret ",
      saveAs: false,
      policy: {
        includeScreenshots: false,
        includeScreenRecordings: true,
        maxArchiveBytes: 256 * 1024 * 1024,
        recentWindowMs: 45 * 60 * 1000
      }
    });
  });

  it("shows export progress and uses runtime acknowledgement when available", async () => {
    const port = new FakePort();
    let resolveExport: (value: unknown) => void = () => undefined;
    const sendMessage = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveExport = resolve;
        })
    );
    installChromeStub(port, { sendMessage });

    await importPopupModule();

    port.emit({
      kind: "sw.session-list",
      sessions: [
        {
          sid: "sid-export-runtime",
          tabId: 17,
          mode: "full",
          startedAt: Date.now(),
          active: false
        }
      ]
    });
    await flushPopup();

    getExportButton().click();
    await flushPopup();

    const promptForm = document.querySelector<HTMLFormElement>("form.wb-prompt-card");
    const passphraseInput = document.querySelector<HTMLInputElement>("#wb-passphrase-input");

    if (!promptForm || !passphraseInput) {
      throw new Error("missing export prompt");
    }

    passphraseInput.value = "export-secret";
    passphraseInput.dispatchEvent(new Event("input", { bubbles: true }));
    getPassphraseSubmitButton().click();
    await flushPopup();

    expect(getStatusLine().textContent).toBe("Exporting...");
    expect(getExportButton().disabled).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ui.export",
        sid: "sid-export-runtime",
        passphrase: "export-secret",
        saveAs: false
      })
    );

    resolveExport({
      ok: true,
      fileName: "sid-export-runtime.webblackbox"
    });
    await flushPopup();

    expect(getStatusLine().textContent).toBe("Exported: sid-export-runtime.webblackbox");
    expect(getExportButton().disabled).toBe(false);
  });

  it("shows export privacy findings inline with the download success, never in an alert", async () => {
    const port = new FakePort();
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    const sendMessage = vi.fn(async () => ({
      ok: true,
      fileName: "sid-export-warning.webblackbox",
      privacyWarning: EXPORT_PRIVACY_WARNING
    }));
    installChromeStub(port, { sendMessage });

    await importPopupModule();

    port.emit({
      kind: "sw.session-list",
      sessions: [
        {
          sid: "sid-export-warning",
          tabId: 17,
          mode: "full",
          startedAt: Date.now(),
          active: false
        }
      ]
    });
    await flushPopup();

    getExportButton().click();
    await flushPopup();

    const passphraseInput = document.querySelector<HTMLInputElement>("#wb-passphrase-input");

    if (!passphraseInput) {
      throw new Error("missing passphrase input");
    }

    passphraseInput.value = "export-secret";
    passphraseInput.dispatchEvent(new Event("input", { bubbles: true }));
    getPassphraseSubmitButton().click();
    await flushPopup();

    expect(getStatusLine().textContent).toBe("Exported: sid-export-warning.webblackbox");
    expect(document.querySelector(".wb-popup__privacy-warning")?.textContent).toContain(
      "email in event:E-1, jwt in event:E-2"
    );

    port.emit({
      kind: "sw.export-status",
      sid: "sid-export-warning",
      ok: true,
      fileName: "sid-export-warning.webblackbox",
      privacyWarning: EXPORT_PRIVACY_WARNING
    });
    await flushPopup();

    expect(document.querySelector(".wb-popup__privacy-warning[role='status']")).not.toBeNull();

    getExportButton().click();
    await flushPopup();

    const repeatPassphraseInput = document.querySelector<HTMLInputElement>("#wb-passphrase-input");

    if (!repeatPassphraseInput) {
      throw new Error("missing repeat passphrase input");
    }

    repeatPassphraseInput.value = "export-secret";
    repeatPassphraseInput.dispatchEvent(new Event("input", { bubbles: true }));
    getPassphraseSubmitButton().click();
    await flushPopup();

    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("shows a retryable failure when the export acknowledgement stalls", async () => {
    vi.useFakeTimers();

    const port = new FakePort();
    const sendMessage = vi.fn(() => new Promise(() => undefined));
    installChromeStub(port, { sendMessage });

    await importPopupModuleWithFakeTimers();

    port.emit({
      kind: "sw.session-list",
      sessions: [
        {
          sid: "sid-export-stalled",
          tabId: 17,
          mode: "full",
          startedAt: Date.now(),
          active: false
        }
      ]
    });
    await flushPopupWithFakeTimers();

    getExportButton().click();
    await flushPopupWithFakeTimers();

    const promptForm = document.querySelector<HTMLFormElement>("form.wb-prompt-card");
    const passphraseInput = document.querySelector<HTMLInputElement>("#wb-passphrase-input");

    if (!promptForm || !passphraseInput) {
      throw new Error("missing export prompt");
    }

    passphraseInput.value = "export-secret";
    passphraseInput.dispatchEvent(new Event("input", { bubbles: true }));
    getPassphraseSubmitButton().click();
    await flushPopupWithFakeTimers();

    expect(getStatusLine().textContent).toBe("Exporting...");
    expect(getExportButton().disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(120_000);
    await flushPopupWithFakeTimers();

    expect(getStatusLine().textContent).toBe(
      "Export failed: Export did not finish within 2 minutes. Check Chrome downloads or reload the extension and retry."
    );
    expect(getExportButton().disabled).toBe(false);
  });

  it("exports only with a passphrase of at least 8 characters", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();

    port.emit({
      kind: "sw.session-list",
      sessions: [
        {
          sid: "sid-passphrase",
          tabId: 17,
          mode: "lite",
          startedAt: Date.now(),
          active: false
        }
      ]
    });
    await flushPopup();

    getExportButton().click();
    await flushPopup();

    const passphraseInput = document.querySelector<HTMLInputElement>("#wb-passphrase-input");

    if (!passphraseInput) {
      throw new Error("missing passphrase input");
    }

    for (const value of ["", "       ", "short12"]) {
      passphraseInput.value = value;
      passphraseInput.dispatchEvent(new Event("input", { bubbles: true }));
      getPassphraseSubmitButton().click();
      await flushPopup();

      expect(port.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "ui.export" })
      );
      expect(passphraseInput.validationMessage).toContain("at least 8 characters");
    }

    passphraseInput.value = "long-enough";
    passphraseInput.dispatchEvent(new Event("input", { bubbles: true }));
    getPassphraseSubmitButton().click();
    await flushPopup();

    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ui.export",
        sid: "sid-passphrase",
        passphrase: "long-enough"
      })
    );
  });
  it("opens the sessions and options pages from the popup", async () => {
    const port = new FakePort();
    installChromeStub(port);
    const windowClose = vi.spyOn(window, "close").mockImplementation(() => undefined);

    await importPopupModule();

    getSessionsButton().click();
    getOptionsButton().click();
    await flushPopup();

    const tabsCreate = (
      globalThis as typeof globalThis & {
        chrome?: {
          tabs?: {
            create?: ReturnType<typeof vi.fn>;
          };
        };
      }
    ).chrome?.tabs?.create;

    expect(tabsCreate).toHaveBeenNthCalledWith(1, {
      url: "chrome-extension://test-extension/sessions.html",
      active: true
    });
    expect(tabsCreate).toHaveBeenNthCalledWith(2, {
      url: "chrome-extension://test-extension/options.html",
      active: true
    });
    expect(windowClose).toHaveBeenCalledTimes(2);
  });

  it("disables start buttons only when the current tab is already recording", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();

    port.emit({
      kind: "sw.session-list",
      sessions: [
        {
          sid: "sid-current",
          tabId: 17,
          mode: "lite",
          startedAt: Date.now(),
          active: true
        }
      ]
    });
    await flushPopup();

    expect(getStartLiteButton().disabled).toBe(true);
    expect(getStartFullButton().disabled).toBe(true);
    expect(getFullVisualCaptureRadio("screenshots").disabled).toBe(true);
    expect(getFullVisualCaptureRadio("recording").disabled).toBe(true);
    expect(getFullVisualCaptureRadio("both").disabled).toBe(true);
    expect(getFullVisualCaptureRadio("none").disabled).toBe(true);

    port.emit({
      kind: "sw.session-list",
      sessions: [
        {
          sid: "sid-other",
          tabId: 42,
          mode: "full",
          startedAt: Date.now(),
          active: true
        }
      ]
    });
    await flushPopup();

    expect(getStartLiteButton().disabled).toBe(false);
    expect(getStartFullButton().disabled).toBe(false);
    expect(getFullVisualCaptureRadio("screenshots").disabled).toBe(false);
    expect(getFullVisualCaptureRadio("recording").disabled).toBe(false);
    expect(getFullVisualCaptureRadio("both").disabled).toBe(false);
    expect(getFullVisualCaptureRadio("none").disabled).toBe(false);
  });

  it("refreshes active session state when reopening after the initial connect push was missed", async () => {
    const activeSessions = [
      {
        sid: "sid-full-active",
        tabId: 17,
        mode: "full",
        startedAt: Date.now(),
        active: true
      }
    ];
    const port = new FakePort((message, currentPort) => {
      if ((message as { kind?: unknown }).kind === "ui.request-session-list") {
        currentPort.emit({
          kind: "sw.session-list",
          sessions: activeSessions
        });
      }
    });
    installChromeStub(port, {
      onQuery: () => {
        port.emit({
          kind: "sw.session-list",
          sessions: activeSessions
        });
      }
    });

    await importPopupModule();

    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "ui.request-session-list"
    });
    expect(getStartFullButton().disabled).toBe(true);
    expect(getStartLiteButton().disabled).toBe(true);
    expect(getFullVisualCaptureRadio("screenshots").disabled).toBe(true);
    expect(getFullVisualCaptureRadio("recording").disabled).toBe(true);
    expect(getFullVisualCaptureRadio("both").disabled).toBe(true);
    expect(getFullVisualCaptureRadio("none").disabled).toBe(true);
    expect(getStopButton().disabled).toBe(false);
    expect(document.body.textContent).toContain("Recording (Full)");
  });

  it("asks before starting lite with a page reload", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();

    getStartLiteButton().click();
    await flushPopup();

    expect(document.querySelector(".wb-confirm-overlay")).not.toBeNull();
    expect(getLiteReloadStartButton().textContent).toBe("Reload and Start Lite");
    expect(port.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ui.start",
        mode: "lite"
      })
    );

    getLiteReloadStartButton().click();
    await flushPopup();

    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "ui.start",
      tabId: 17,
      mode: "lite",
      reloadPage: true
    });
    expect(document.querySelector(".wb-confirm-overlay")).toBeNull();
  });

  it("can start lite without reloading when the user chooses the non-refresh path", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();

    getStartLiteButton().click();
    await flushPopup();
    getLiteDirectStartButton().click();
    await flushPopup();

    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "ui.start",
      tabId: 17,
      mode: "lite"
    });
  });

  it("does not start lite when the reload confirmation is cancelled", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();

    getStartLiteButton().click();
    await flushPopup();
    getLiteStartCancelButton().click();
    await flushPopup();

    expect(port.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ui.start",
        mode: "lite"
      })
    );
    expect(document.querySelector(".wb-confirm-overlay")).toBeNull();
  });

  it("keeps start buttons disabled while a full start request is pending", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();

    getStartFullButton().click();
    await flushPopup();

    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "ui.start",
      tabId: 17,
      mode: "full",
      visualCapture: "screenshots"
    });
    expect(getStartLiteButton().disabled).toBe(true);
    expect(getStartFullButton().disabled).toBe(true);

    port.emit({
      kind: "sw.session-list",
      sessions: []
    });
    await flushPopup();

    expect(getStartLiteButton().disabled).toBe(true);
    expect(getStartFullButton().disabled).toBe(true);

    port.emit({
      kind: "sw.session-list",
      sessions: [
        {
          sid: "sid-started",
          tabId: 17,
          mode: "full",
          startedAt: Date.now(),
          active: true
        }
      ]
    });
    await flushPopup();
  });

  it("starts full mode with recording-only visual capture when explicitly selected", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();

    const screenshots = getFullVisualCaptureRadio("screenshots");
    const recording = getFullVisualCaptureRadio("recording");
    expect(screenshots.checked).toBe(true);
    expect(recording.checked).toBe(false);

    recording.checked = true;
    recording.dispatchEvent(new Event("change", { bubbles: true }));
    getStartFullButton().click();
    await flushPopup();

    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "ui.start",
      tabId: 17,
      mode: "full",
      visualCapture: "recording"
    });
  });

  it("starts full mode with screenshots and recording when both is selected", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();

    const both = getFullVisualCaptureRadio("both");
    both.checked = true;
    both.dispatchEvent(new Event("change", { bubbles: true }));
    getStartFullButton().click();
    await flushPopup();

    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "ui.start",
      tabId: 17,
      mode: "full",
      visualCapture: "both"
    });
  });

  it("starts full mode without visual capture when none is selected", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();

    const none = getFullVisualCaptureRadio("none");
    none.checked = true;
    none.dispatchEvent(new Event("change", { bubbles: true }));
    getStartFullButton().click();
    await flushPopup();

    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "ui.start",
      tabId: 17,
      mode: "full",
      visualCapture: "none"
    });
  });

  it("exports no visual artifacts when none is selected", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();

    const none = getFullVisualCaptureRadio("none");
    none.checked = true;
    none.dispatchEvent(new Event("change", { bubbles: true }));

    port.emit({
      kind: "sw.session-list",
      sessions: [
        {
          sid: "sid-none-export",
          tabId: 17,
          mode: "full",
          startedAt: Date.now(),
          active: false
        }
      ]
    });
    await flushPopup();

    getExportButton().click();
    await flushPopup();
    enterPassphrase("none-export-secret");
    getPassphraseSubmitButton().click();
    await flushPopup();

    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "ui.export",
      sid: "sid-none-export",
      passphrase: "none-export-secret",
      saveAs: false,
      policy: {
        includeScreenshots: false,
        includeScreenRecordings: false,
        maxArchiveBytes: 100 * 1024 * 1024,
        recentWindowMs: 20 * 60 * 1000
      }
    });
  });

  it("preserves the full visual capture mode across popup reopen", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();

    const recording = getFullVisualCaptureRadio("recording");
    recording.checked = true;
    recording.dispatchEvent(new Event("change", { bubbles: true }));

    expect(localStorage.getItem(POPUP_FULL_VISUAL_CAPTURE_STORAGE_KEY)).toBe("recording");

    document.body.innerHTML = `<main id="popup-root"></main>`;
    const reopenedPort = new FakePort();
    installChromeStub(reopenedPort);
    await importPopupModule();

    expect(getFullVisualCaptureRadio("screenshots").checked).toBe(false);
    expect(getFullVisualCaptureRadio("recording").checked).toBe(true);

    getStartFullButton().click();
    await flushPopup();

    expect(reopenedPort.postMessage).toHaveBeenCalledWith({
      kind: "ui.start",
      tabId: 17,
      mode: "full",
      visualCapture: "recording"
    });
  });

  it("renders the ring buffer meter without inline styles", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();

    port.emit({
      kind: "sw.session-list",
      sessions: [
        {
          sid: "sid-current",
          tabId: 17,
          mode: "lite",
          startedAt: Date.now() - 3 * 60 * 1000,
          ringBufferMinutes: 10,
          active: true
        }
      ]
    });
    await flushPopup();

    const meter = document.querySelector<HTMLProgressElement>("progress.wb-popup__buffer-meter");

    expect(meter).not.toBeNull();
    expect(meter?.value).toBeGreaterThan(0);
    expect(document.querySelector("[style]")).toBeNull();
  });
});

describe("popup recording profiles", () => {
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
      extended: true
    }
  };

  beforeEach(() => {
    document.body.innerHTML = `<main id="popup-root"></main>`;
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function getProfileSelect(): HTMLSelectElement {
    const select = document.querySelector<HTMLSelectElement>("[data-profile-select]");

    if (!select) {
      throw new Error("missing profile select");
    }

    return select;
  }

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
    expect(document.querySelector("[data-profile-hint]")?.textContent).toBe(
      "Records with QA (rule: Stage). Recommended start: Full."
    );
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

    getStartFullButton().click();
    await flushPopup();

    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "ui.start",
      tabId: 17,
      mode: "full",
      profileId: "builtin:qa",
      visualCapture: "screenshots"
    });
  });

  it("shows export failures without asking to confirm anything", async () => {
    const port = new FakePort();
    const sendMessage = vi.fn().mockResolvedValue({ ok: false, error: "disk full" });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    installChromeStub(port, { sendMessage });

    await importPopupModule();
    port.emit({
      kind: "sw.session-list",
      sessions: [{ sid: "sid-qa", tabId: 17, mode: "full", startedAt: Date.now(), active: false }]
    });
    await flushPopup();

    getExportButton().click();
    await flushPopup();
    enterPassphrase("qa-secret-1");
    getPassphraseSubmitButton().click();
    await flushPopup();
    await flushPopup();

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(
      sendMessage.mock.calls.filter(([message]) => message?.kind === "ui.export")
    ).toHaveLength(1);
    expect(getStatusLine().textContent).toContain("disk full");
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

    expect(document.querySelector("[data-profile-hint]")?.textContent).toBe(
      "Records with QA (rule: Stage). Your organization's policy limits: console, network. Recommended start: Full."
    );
  });

  it("requires a profile when every profile was deleted and links to the profiles page", async () => {
    const port = new FakePort();
    installChromeStub(port);
    vi.spyOn(window, "close").mockImplementation(() => undefined);

    await importPopupModule();

    expect(document.querySelector("[data-profile-required]")).toBeNull();

    port.emit({ kind: "sw.profile-preview", catalog: [], selection: null });
    await flushPopup();

    expect(document.querySelector("[data-profile-required]")?.textContent).toBe(
      "No recording profile" +
        "Recording needs at least one profile. Create one or restore the recommended profiles." +
        "Open profiles"
    );
    expect(getStartLiteButton().disabled).toBe(true);
    expect(getStartFullButton().disabled).toBe(true);

    document
      .querySelector<HTMLButtonElement>("[data-profile-required] [data-action='open-profiles']")
      ?.click();
    await flushPopup();

    expect(
      (globalThis as typeof globalThis & { chrome: { tabs: { create: ReturnType<typeof vi.fn> } } })
        .chrome.tabs.create
    ).toHaveBeenCalledWith({
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
          sid: "sid-cancelled",
          tabId: 17,
          mode: "full",
          startedAt: Date.now() - 5_000,
          stoppedAt: Date.now(),
          active: false,
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

    const notice = document.querySelector<HTMLElement>("[data-profile-cancel]");

    expect(notice?.getAttribute("role")).toBe("alert");
    expect(
      [...(notice?.querySelectorAll("strong, p") ?? [])].map((node) => node.textContent)
    ).toEqual([
      "Recording stopped: the profile changed",
      "It recorded with QA, but the site rules pick Default for this page.",
      "To keep recording here with QA, choose it in the profile list instead of Auto, or add a site rule for this site in Options → Profiles.",
      "What was recorded before the change is kept: export or delete it."
    ]);
    expect(getExportButton().disabled).toBe(false);

    notice?.querySelector<HTMLButtonElement>("[data-action='ack-profile-cancel']")?.click();
    await flushPopup();

    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "ui.ack-profile-cancel",
      sid: "sid-cancelled"
    });
  });
});
