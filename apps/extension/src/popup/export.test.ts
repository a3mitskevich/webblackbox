// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  chooseRadio,
  FakePort,
  flushPopup,
  flushPopupWithFakeTimers,
  getButton,
  getStatusLine,
  importPopupModule,
  importPopupModuleWithFakeTimers,
  installChromeStub,
  resetPopupDom,
  stoppedSession,
  submitExport
} from "./popup-test-harness.js";

const EXPORT_POLICY_STORAGE_KEY = "webblackbox.popup.export-policy";
const EXPORT_PRIVACY_WARNING = {
  findingCount: 2,
  summary: "email in event:E-1, jwt in event:E-2",
  findings: [
    { kind: "email", path: "event:E-1", matchCount: 1 },
    { kind: "jwt", path: "event:E-2", matchCount: 1 }
  ]
};
const DEFAULT_POLICY = {
  maxArchiveBytes: 100 * 1024 * 1024,
  recentWindowMs: 20 * 60 * 1000
};

async function openWithSession(
  port: FakePort,
  session: ReturnType<typeof stoppedSession>,
  importModule = importPopupModule,
  flush = flushPopup
): Promise<void> {
  await importModule();
  port.emit({ kind: "sw.session-list", sessions: [session] });
  await flush();
}

describe("popup export", () => {
  beforeEach(resetPopupDom);

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    Reflect.deleteProperty(globalThis, "chrome");
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("has no archive policy inputs: the limits come from the options page", async () => {
    localStorage.setItem(
      EXPORT_POLICY_STORAGE_KEY,
      JSON.stringify({ alertSensitiveFindings: true, maxArchiveMb: 256, recentMinutes: 45 })
    );
    const port = new FakePort();
    installChromeStub(port);

    await openWithSession(port, stoppedSession("sid-1"));

    expect(document.querySelector("#export-max-size-mb")).toBeNull();
    expect(document.querySelector("#export-recent-minutes")).toBeNull();
    expect(document.querySelector(".wb-popup__last")?.textContent).toContain(
      "≤ 256 MB · last 45 min"
    );

    chooseRadio("capture-mode", "full");
    await flushPopup();
    chooseRadio("full-visual-capture", "recording");
    await submitExport(" export-secret ");

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

  it("accepts archive limits stored as text by the previous popup", async () => {
    localStorage.setItem(
      EXPORT_POLICY_STORAGE_KEY,
      JSON.stringify({ alertSensitiveFindings: true, maxArchiveMb: "64", recentMinutes: "" })
    );
    const port = new FakePort();
    installChromeStub(port);

    await openWithSession(port, stoppedSession("sid-text", "lite"));
    await submitExport();

    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ui.export",
        policy: expect.objectContaining({
          maxArchiveBytes: 64 * 1024 * 1024,
          recentWindowMs: DEFAULT_POLICY.recentWindowMs
        })
      })
    );
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

    await openWithSession(port, stoppedSession("sid-export-runtime"));
    await submitExport("export-secret");

    expect(getStatusLine().textContent).toBe("Exporting...");
    expect(getButton("export").disabled).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ui.export",
        sid: "sid-export-runtime",
        passphrase: "export-secret",
        saveAs: false
      })
    );

    resolveExport({ ok: true, fileName: "sid-export-runtime.webblackbox" });
    await flushPopup();

    expect(getStatusLine().textContent).toBe("Exported: sid-export-runtime.webblackbox");
    expect(getButton("export").disabled).toBe(false);
  });

  it("alerts and keeps the download success visible when export privacy findings are present", async () => {
    const port = new FakePort();
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    const sendMessage = vi.fn(async () => ({
      ok: true,
      fileName: "sid-export-warning.webblackbox",
      privacyWarning: EXPORT_PRIVACY_WARNING
    }));
    installChromeStub(port, { sendMessage });

    await openWithSession(port, stoppedSession("sid-export-warning"));
    await submitExport("export-secret");

    expect(getStatusLine().textContent).toBe("Exported: sid-export-warning.webblackbox");
    expect(alertSpy).toHaveBeenCalledWith(
      "Export completed, but the privacy scanner found 2 possible sensitive item(s): email in event:E-1, jwt in event:E-2. Review the archive before sharing."
    );
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

    expect(alertSpy).toHaveBeenCalledTimes(1);

    await submitExport("export-secret");

    expect(alertSpy).toHaveBeenCalledTimes(2);
  });

  it("suppresses popup privacy alerts when sensitive finding alerts are disabled in options", async () => {
    localStorage.setItem(
      EXPORT_POLICY_STORAGE_KEY,
      JSON.stringify({ alertSensitiveFindings: false, maxArchiveMb: 100, recentMinutes: 20 })
    );
    const port = new FakePort();
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    const sendMessage = vi.fn(async () => ({
      ok: true,
      fileName: "sid-export-muted.webblackbox",
      privacyWarning: EXPORT_PRIVACY_WARNING
    }));
    installChromeStub(port, { sendMessage });

    await openWithSession(port, stoppedSession("sid-export-muted"));
    await submitExport("export-secret");

    expect(getStatusLine().textContent).toBe("Exported: sid-export-muted.webblackbox");
    expect(alertSpy).not.toHaveBeenCalled();
    expect(document.querySelector(".wb-popup__privacy-warning")).toBeNull();
  });

  it("shows a retryable failure when the export acknowledgement stalls", async () => {
    vi.useFakeTimers();
    const port = new FakePort();
    installChromeStub(port, { sendMessage: vi.fn(() => new Promise(() => undefined)) });

    await openWithSession(
      port,
      stoppedSession("sid-export-stalled"),
      importPopupModuleWithFakeTimers,
      flushPopupWithFakeTimers
    );
    await submitExport("export-secret", flushPopupWithFakeTimers);

    expect(getStatusLine().textContent).toBe("Exporting...");
    expect(getButton("export").disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(120_000);
    await flushPopupWithFakeTimers();

    expect(getStatusLine().textContent).toBe(
      "Export failed: Export did not finish within 2 minutes. Check Chrome downloads or reload the extension and retry."
    );
    expect(getButton("export").disabled).toBe(false);
  });

  it("exports without encryption when the passphrase prompt is left empty", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await openWithSession(port, stoppedSession("sid-empty-passphrase", "lite"));
    await submitExport();

    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "ui.export",
      sid: "sid-empty-passphrase",
      saveAs: false,
      policy: { includeScreenshots: false, includeScreenRecordings: false, ...DEFAULT_POLICY }
    });
  });

  it("does not export when the passphrase dialog is cancelled with Escape", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await openWithSession(port, stoppedSession("sid-cancel"));
    getButton("export").click();
    await flushPopup();

    expect(document.activeElement?.id).toBe("wb-passphrase-input");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPopup();

    expect(document.querySelector(".wb-confirm-overlay")).toBeNull();
    expect(port.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ui.export" })
    );
  });

  it("exports no visual artifacts when none is selected", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await openWithSession(port, stoppedSession("sid-none-export"));
    chooseRadio("capture-mode", "full");
    await flushPopup();
    chooseRadio("full-visual-capture", "none");
    await submitExport();

    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "ui.export",
      sid: "sid-none-export",
      saveAs: false,
      policy: { includeScreenshots: false, includeScreenRecordings: false, ...DEFAULT_POLICY }
    });
  });

  it("re-sends the export after the user acknowledges blocking privacy findings", async () => {
    const port = new FakePort();
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: "Privacy scanner blocked export: jwt in event:E-1",
        privacyBlocked: true
      })
      .mockResolvedValueOnce({ ok: true, fileName: "sid-qa.webblackbox" });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    installChromeStub(port, { sendMessage });

    await openWithSession(port, stoppedSession("sid-qa"));
    await submitExport("qa-secret");
    await flushPopup();

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("jwt in event:E-1"));
    expect(sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "ui.export",
        sid: "sid-qa",
        passphrase: "qa-secret",
        acknowledgePrivacyFindings: true
      })
    );
    expect(getStatusLine().textContent).toBe("Exported: sid-qa.webblackbox");
  });

  it("keeps the failure when the user declines the privacy confirmation", async () => {
    const port = new FakePort();
    const sendMessage = vi.fn().mockResolvedValue({
      ok: false,
      error: "Privacy scanner blocked export: jwt in event:E-1",
      privacyBlocked: true
    });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    installChromeStub(port, { sendMessage });

    await openWithSession(port, stoppedSession("sid-qa"));
    await submitExport();

    expect(
      sendMessage.mock.calls.filter(([message]) => message?.kind === "ui.export")
    ).toHaveLength(1);
    expect(getStatusLine().textContent).toContain("Privacy scanner blocked export");
  });
});
