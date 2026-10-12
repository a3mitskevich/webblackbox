// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CaptureFallback } from "../shared/capture-fallback.js";
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
  resetPopupDom,
  stoppedSession,
  submitExport
} from "./popup-test-harness.js";

const has = (selector: string): boolean => document.querySelector(selector) !== null;

const CANCELLED: CaptureFallback = {
  at: Date.now(),
  reason: "canceled-by-user",
  from: "full",
  to: "lite",
  detail: "canceled_by_user"
};

function promptingSession(sid = "sid-stopped") {
  return {
    ...stoppedSession(sid, "full"),
    stoppedAt: Date.now(),
    exportPrompt: true as const,
    eventCount: 12,
    profileId: "builtin:maximum",
    profileName: "Maximum"
  };
}

async function open(port: FakePort, sessions: unknown[], remembered?: boolean): Promise<void> {
  await importPopupModule();
  port.emit({ kind: "sw.session-list", sessions });

  if (remembered !== undefined) {
    port.emit({ kind: "sw.passphrase-status", remembered });
  }

  await flushPopup();
}

describe("popup export step", () => {
  beforeEach(resetPopupDom);

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "chrome");
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("asks the service worker whether a passphrase is remembered", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importPopupModule();

    expect(postedOfKind(port, "ui.passphrase-status")).toEqual([{ kind: "ui.passphrase-status" }]);
  });

  it("switches to the export step after Stop, in Record's place", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await open(port, [promptingSession()]);

    const step = query<HTMLElement>("[data-export-step]");
    expect(step.querySelector(".wb-panel__title")?.textContent).toBe(
      "Recording stopped — export it now"
    );
    expect(getButton("export").textContent).toBe("Export archive");
    expect(getButton("export").classList.contains("wb-btn--brand")).toBe(true);
    expect(has("[data-action='start']")).toBe(false);
    expect(has(".wb-popup__last")).toBe(false);
    expect(step.textContent).toContain("12");
  });

  it("puts the export off with Later; the recording stays for the sessions page", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await open(port, [promptingSession()]);
    getButton("export-later").click();
    await flushPopup();

    expect(postedOfKind(port, "ui.dismiss-export")).toEqual([
      { kind: "ui.dismiss-export", sid: "sid-stopped" }
    ]);

    // The service worker drops the prompt: Record and the last session come back.
    await open(port, [{ ...promptingSession(), exportPrompt: undefined }]);

    expect(has("[data-export-step]")).toBe(false);
    expect(getButton("start").disabled).toBe(false);
    expect(getButton("export").disabled).toBe(false);
  });

  it("asks for a passphrase when none is remembered, and says it will be", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await open(port, [promptingSession()], false);

    expect(query("[data-passphrase-state]").getAttribute("data-passphrase-state")).toBe("ask");
    expect(query("[data-passphrase-state]").textContent).toBe(
      "The export asks for a passphrase once; it is remembered until the browser closes."
    );

    await submitExport("first-export-secret");

    expect(postedOfKind(port, "ui.export")).toEqual([
      expect.objectContaining({ sid: "sid-stopped", passphrase: "first-export-secret" })
    ]);
  });

  it("exports with the remembered passphrase without asking", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await open(port, [promptingSession()], true);

    expect(query("[data-passphrase-state]").textContent).toBe(
      "Passphrase remembered until the browser closes · Forget passphrase"
    );

    getButton("export").click();
    await flushPopup();

    expect(has(".wb-confirm-overlay")).toBe(false);
    const [exported] = postedOfKind(port, "ui.export");
    expect(exported).toMatchObject({ kind: "ui.export", sid: "sid-stopped", saveAs: false });
    expect(exported).not.toHaveProperty("passphrase");
  });

  it("forgets the remembered passphrase on request", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await open(port, [promptingSession()], true);
    getButton("forget-passphrase").click();
    await flushPopup();

    expect(postedOfKind(port, "ui.forget-passphrase")).toEqual([{ kind: "ui.forget-passphrase" }]);
    expect(getStatusLine().textContent).toBe("Passphrase forgotten: the next export asks for it.");

    port.emit({ kind: "sw.passphrase-status", remembered: false });
    await flushPopup();

    expect(query("[data-passphrase-state]").getAttribute("data-passphrase-state")).toBe("ask");
  });

  it("asks again whether a passphrase is remembered after a successful export", async () => {
    const port = new FakePort();
    const sendMessage = vi.fn(async () => ({ ok: true, fileName: "s.webblackbox" }));
    installChromeStub(port, { sendMessage });

    await open(port, [promptingSession()], false);
    port.postMessage.mockClear();
    await submitExport("first-export-secret");

    expect(getStatusLine().textContent).toBe("Exported: s.webblackbox");
    expect(postedOfKind(port, "ui.passphrase-status")).toHaveLength(1);
  });

  it("names a built-in profile in the UI language whatever name the list carries", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await open(port, [{ ...promptingSession(), profileName: "Stored name" }]);

    expect(query("[data-export-step] .wb-panel__meta").textContent).toContain("Maximum");
    expect(query("[data-export-step] .wb-panel__meta").textContent).not.toContain("Stored name");
  });
});

describe("popup capture fallback", () => {
  beforeEach(resetPopupDom);

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "chrome");
    document.body.innerHTML = "";
  });

  it("warns while the current tab's recording goes on in Light", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await open(port, [{ ...activeSession("sid-live", "lite"), captureFallback: CANCELLED }]);

    const warning = query<HTMLElement>("[data-capture-fallback='canceled-by-user']");
    expect(warning.getAttribute("role")).toBe("alert");
    expect([...warning.children].map((node) => node.textContent)).toEqual([
      "Full capture stopped — recording continues in Light",
      "“Cancel” was pressed on Chrome's “started debugging this browser” bar.",
      "No longer captured: response bodies, full console with stacks, screenshots and DevTools network data. Page-side capture goes on; the archive records when and why."
    ]);
    expect(getButton("stop").disabled).toBe(false);
  });

  it("explains a browser page that never allowed Full", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await open(port, [
      {
        ...activeSession("sid-live", "lite"),
        captureFallback: { ...CANCELLED, reason: "restricted-page" }
      }
    ]);

    expect(query("[data-capture-fallback='restricted-page']").textContent).toContain(
      "This page does not allow the debugger"
    );
  });

  it("does not warn for another tab's recording or a recording that stayed in Full", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await open(port, [
      { ...activeSession("sid-other", "lite", 42), captureFallback: CANCELLED },
      activeSession("sid-here", "full")
    ]);

    expect(has("[data-capture-fallback]")).toBe(false);
  });

  it("keeps the warning in the export step of a stopped recording", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await open(port, [{ ...promptingSession(), mode: "lite", captureFallback: CANCELLED }]);

    expect(has("[data-export-step] [data-capture-fallback='canceled-by-user']")).toBe(true);
  });
});
