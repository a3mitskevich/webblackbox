// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionListItem } from "../shared/messages.js";

type PortMessageHandler = (message: unknown) => void;

class FakePort {
  readonly postMessage = vi.fn();
  private readonly handlers = new Set<PortMessageHandler>();
  readonly onMessage = {
    addListener: (handler: PortMessageHandler): void => {
      this.handlers.add(handler);
    },
    removeListener: (handler: PortMessageHandler): void => {
      this.handlers.delete(handler);
    }
  };
  readonly onDisconnect = {
    addListener: (): void => undefined,
    removeListener: (): void => undefined
  };

  emit(message: unknown): void {
    this.handlers.forEach((handler) => handler(message));
  }
}

const NOW = Date.now();
const STOPPED: SessionListItem = {
  sid: "sid-kept",
  tabId: 2,
  mode: "lite",
  startedAt: NOW - 120_000,
  stoppedAt: NOW - 60_000,
  active: false,
  url: "https://shop.example.com/cart",
  title: "Cart",
  profileId: "builtin:maximum",
  profileName: "Maximum",
  exportPrompt: true,
  captureFallback: { at: NOW - 90_000, reason: "canceled-by-user", from: "full", to: "lite" }
};
const LIVE: SessionListItem = {
  sid: "sid-live",
  tabId: 1,
  mode: "full",
  startedAt: NOW - 10_000,
  active: true,
  url: "https://shop.example.com/",
  title: "Shop",
  profileId: "builtin:lite",
  profileName: "Light"
};

function setup(): FakePort {
  const port = new FakePort();
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    writable: true,
    value: { runtime: { connect: vi.fn(() => port) }, tabs: { create: vi.fn() } }
  });
  return port;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function load(
  port: FakePort,
  options: { remembered?: boolean; sessions?: SessionListItem[] } = {}
): Promise<void> {
  vi.resetModules();
  await import("./index.js");
  port.emit({ kind: "sw.session-list", sessions: options.sessions ?? [LIVE, STOPPED] });

  if (options.remembered !== undefined) {
    port.emit({ kind: "sw.passphrase-status", remembered: options.remembered });
  }

  await flush();
}

const posted = (port: FakePort, kind: string): unknown[] =>
  port.postMessage.mock.calls
    .map(([message]) => message as { kind: string })
    .filter((message) => message.kind === kind);
const has = (selector: string): boolean => document.querySelector(selector) !== null;
const click = (selector: string): void => document.querySelector<HTMLElement>(selector)?.click();

describe("sessions page export", () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="sessions-root"></main>`;
    history.replaceState(null, "", "/sessions.html");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "chrome");
    document.body.innerHTML = "";
    history.replaceState(null, "", "/sessions.html");
  });

  it("asks whether a passphrase is remembered and exports with it without a dialog", async () => {
    const port = setup();
    await load(port, { remembered: true });

    expect(posted(port, "ui.passphrase-status")).toEqual([{ kind: "ui.passphrase-status" }]);

    click(`[data-export='${STOPPED.sid}']`);
    await flush();

    expect(has("#wb-passphrase-input")).toBe(false);
    expect(posted(port, "ui.export")).toEqual([
      expect.not.objectContaining({ passphrase: expect.anything() })
    ]);
    expect(posted(port, "ui.export")[0]).toMatchObject({ kind: "ui.export", sid: STOPPED.sid });
  });

  it("shows the remembered passphrase and forgets it on request", async () => {
    const port = setup();
    await load(port, { remembered: true });

    expect(document.querySelector("[data-passphrase-control]")?.textContent).toContain(
      "Passphrase remembered until the browser closes"
    );

    click("[data-forget-passphrase]");
    port.emit({ kind: "sw.passphrase-status", remembered: false });
    await flush();

    expect(posted(port, "ui.forget-passphrase")).toEqual([{ kind: "ui.forget-passphrase" }]);
    expect(has("[data-forget-passphrase]")).toBe(false);
  });

  it("asks for a passphrase when none is remembered", async () => {
    const port = setup();
    await load(port, { remembered: false });

    click(`[data-export='${STOPPED.sid}']`);
    await flush();

    expect(has("#wb-passphrase-input")).toBe(true);
    expect(posted(port, "ui.export")).toEqual([]);
  });

  it("exports the recording a notification links to once, then clears the link", async () => {
    history.replaceState(null, "", `/sessions.html#export=${STOPPED.sid}`);
    const port = setup();
    vi.resetModules();
    await import("./index.js");
    port.emit({ kind: "sw.session-list", sessions: [LIVE, STOPPED] });
    await flush();

    // Waits for the passphrase status: a remembered one must not be asked for.
    expect(has("#wb-passphrase-input")).toBe(false);

    port.emit({ kind: "sw.passphrase-status", remembered: false });
    await flush();
    for (const input of document.querySelectorAll<HTMLInputElement>(
      "#wb-passphrase-input, #wb-passphrase-confirm"
    )) {
      input.value = "team-secret";
    }

    click("[data-passphrase-submit]");
    await flush();
    port.emit({ kind: "sw.session-list", sessions: [LIVE, STOPPED] });
    await flush();

    expect(posted(port, "ui.export")).toEqual([
      expect.objectContaining({ kind: "ui.export", sid: STOPPED.sid, passphrase: "team-secret" })
    ]);
    expect(location.hash).toBe("");
  });

  it("does not export a recording that is still running from a link", async () => {
    history.replaceState(null, "", `/sessions.html#export=${LIVE.sid}`);
    const port = setup();
    await load(port, { remembered: true });

    expect(posted(port, "ui.export")).toEqual([]);
  });

  it("marks recordings that fell back to Light or wait for their export", async () => {
    const port = setup();
    await load(port, { remembered: false });
    const row = (sid: string): HTMLElement | null =>
      document.querySelector<HTMLElement>(`[data-session-sid='${sid}']`);

    expect(row(STOPPED.sid)?.querySelector("[data-capture-fallback='canceled-by-user']")).not.toBe(
      null
    );
    expect(row(STOPPED.sid)?.querySelector("[data-not-exported]")).not.toBe(null);
    expect(row(LIVE.sid)?.querySelector("[data-not-exported]")).toBe(null);
    expect(row(LIVE.sid)?.textContent).toContain("Light");
    expect(row(STOPPED.sid)?.textContent).toContain("Maximum");
  });
});
