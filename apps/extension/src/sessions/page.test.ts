// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionListItem } from "../shared/messages.js";
import { EMPTY_FILTERS, filterSessions, parseTagInput } from "./model.js";

type PortMessageHandler = (message: unknown) => void;
const DEFAULT_EXPORT_POLICY = {
  includeScreenshots: false,
  includeScreenRecordings: false,
  maxArchiveBytes: 100 * 1024 * 1024,
  recentWindowMs: 20 * 60 * 1000
};

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
const SESSIONS: SessionListItem[] = [
  {
    sid: "sid-live",
    tabId: 1,
    mode: "full",
    startedAt: NOW - 60_000,
    active: true,
    url: "https://shop.example.com/cart",
    title: "Cart",
    profileName: "QA",
    errorCount: 2
  },
  {
    sid: "sid-old",
    tabId: 2,
    mode: "lite",
    startedAt: NOW - 3_600_000,
    stoppedAt: NOW - 3_000_000,
    active: false,
    url: "https://admin.example.com/",
    title: "Admin",
    profileName: "Default",
    tags: ["checkout"]
  }
];

const PLAYER_URL_KEY = "webblackbox.playerUrl";

type StorageChangeHandler = (changes: Record<string, unknown>, areaName: string) => void;

/** `local` / `managed`: storage contents; without them the page has no storage (no Player). */
function setup(
  storage: { local?: Record<string, unknown>; managed?: Record<string, unknown> } = {}
) {
  const port = new FakePort();
  const create = vi.fn(async () => ({ id: 5 }));
  const local = { ...storage.local };
  const managed = { ...storage.managed };
  const changeHandlers = new Set<StorageChangeHandler>();
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    writable: true,
    value: {
      runtime: { connect: vi.fn(() => port) },
      tabs: { create },
      ...(storage.local || storage.managed
        ? {
            storage: {
              local: { get: vi.fn(async () => ({ ...local })), set: vi.fn() },
              managed: { get: vi.fn(async () => ({ ...managed })) },
              onChanged: {
                addListener: (handler: StorageChangeHandler) => changeHandlers.add(handler)
              }
            }
          }
        : {})
    }
  });
  const changeStorage = (area: "local" | "managed", values: Record<string, unknown>): void => {
    Object.assign(area === "local" ? local : managed, values);
    changeHandlers.forEach((handler) => handler(values, area));
  };
  return { port, create, changeStorage };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function load(port: FakePort): Promise<void> {
  vi.resetModules();
  await import("./index.js");
  port.emit({ kind: "sw.session-list", sessions: SESSIONS });
  await flush();
}

const rows = (): string[] =>
  [...document.querySelectorAll<HTMLElement>("[data-session-sid]")].map(
    (row) => row.dataset.sessionSid ?? ""
  );

function setControl(selector: string, value: string | boolean): void {
  const control = document.querySelector<HTMLInputElement | HTMLSelectElement>(selector);

  if (!control) {
    throw new Error(`missing ${selector}`);
  }

  if (typeof value === "boolean" && control instanceof HTMLInputElement) {
    control.checked = value;
    control.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  control.value = String(value);
  control.dispatchEvent(
    new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })
  );
}

const click = (selector: string): void => document.querySelector<HTMLElement>(selector)?.click();
/** Archives are always encrypted: the export dialog needs a passphrase of 8+ characters. */
const typePassphrase = (value: string): void => setControl("#wb-passphrase-input", value);
const sids = (sessions: SessionListItem[]): string[] => sessions.map((session) => session.sid);

describe("sessions model", () => {
  it("filters by text, status, profile and errors", () => {
    expect(sids(filterSessions(SESSIONS, { ...EMPTY_FILTERS, query: "checkout" }))).toEqual([
      "sid-old"
    ]);
    expect(sids(filterSessions(SESSIONS, { ...EMPTY_FILTERS, status: "live" }))).toEqual([
      "sid-live"
    ]);
    expect(sids(filterSessions(SESSIONS, { ...EMPTY_FILTERS, profile: "Default" }))).toEqual([
      "sid-old"
    ]);
    expect(sids(filterSessions(SESSIONS, { ...EMPTY_FILTERS, errorsOnly: true }))).toEqual([
      "sid-live"
    ]);
    expect(parseTagInput("a, b, a, ,c")).toEqual(["a", "b", "c"]);
  });
});

describe("sessions page", () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="sessions-root"></main>`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "chrome");
    document.body.innerHTML = "";
  });

  it("lists sessions in a table and filters them", async () => {
    const { port } = setup();
    await load(port);

    expect(rows()).toEqual(["sid-live", "sid-old"]);
    expect(document.querySelector("[data-sessions-count]")?.textContent).toBe("2 total · 1 active");
    expect(document.querySelectorAll("button[data-stop]")).toHaveLength(1);

    setControl("[name='sessionSearch']", "admin");
    expect(rows()).toEqual(["sid-old"]);

    setControl("[name='sessionSearch']", "");
    setControl("[name='sessionProfile']", "QA");
    expect(rows()).toEqual(["sid-live"]);

    setControl("[name='sessionProfile']", "");
    setControl("[name='sessionErrorsOnly']", true);
    expect(rows()).toEqual(["sid-live"]);

    setControl("[name='sessionErrorsOnly']", false);
    setControl("[name='sessionSearch']", "nothing-matches");
    expect(document.querySelector(".wb-sessions-empty")?.textContent).toBe(
      "No sessions match the filters."
    );
  });

  it("exports the selected sessions with one passphrase", async () => {
    const { port } = setup();
    await load(port);

    expect(document.querySelector<HTMLButtonElement>("[data-bulk='export']")?.disabled).toBe(true);

    setControl("[data-select-all]", true);
    expect(document.querySelector("[data-bulk-bar]")?.textContent).toContain("2 selected");

    click("[data-bulk='export']");
    await flush();
    const input = document.querySelector<HTMLInputElement>("#wb-passphrase-input");

    if (input) {
      input.value = "team-secret";
    }

    click("[data-passphrase-submit]");
    await flush();

    for (const sid of ["sid-live", "sid-old"]) {
      expect(port.postMessage).toHaveBeenCalledWith({
        kind: "ui.export",
        sid,
        passphrase: "team-secret",
        saveAs: false,
        policy: DEFAULT_EXPORT_POLICY
      });
    }
  });

  it("deletes the selected sessions after one confirmation", async () => {
    const { port } = setup();
    await load(port);

    setControl("[data-select-sid='sid-old']", true);
    click("[data-bulk='delete']");
    await flush();

    expect(document.querySelector(".wb-confirm-body")?.textContent).toContain(
      "Delete 1 session(s)?"
    );

    click("[data-confirm-accept]");
    await flush();

    expect(port.postMessage).toHaveBeenCalledWith({ kind: "ui.delete", sid: "sid-old" });
    expect(port.postMessage).not.toHaveBeenCalledWith({ kind: "ui.delete", sid: "sid-live" });
  });

  it("never applies a bulk action to rows a filter hides", async () => {
    const { port } = setup();
    await load(port);

    setControl("[data-select-all]", true);
    setControl("input[name='sessionSearch']", "admin");

    expect(rows()).toEqual(["sid-old"]);
    expect(document.querySelector("[data-bulk-bar]")?.textContent).toContain("1 selected");

    setControl("input[name='sessionSearch']", "");

    expect(document.querySelector("[data-bulk-bar]")?.textContent).toContain("1 selected");

    click("[data-bulk='delete']");
    await flush();
    click("[data-confirm-accept]");
    await flush();

    expect(port.postMessage).toHaveBeenCalledWith({ kind: "ui.delete", sid: "sid-old" });
    expect(port.postMessage).not.toHaveBeenCalledWith({ kind: "ui.delete", sid: "sid-live" });
  });

  it("says that a bulk delete stops sessions that are still recording", async () => {
    const { port } = setup();
    await load(port);

    setControl("[data-select-all]", true);
    click("[data-bulk='delete']");
    await flush();

    expect(document.querySelector(".wb-confirm-body")?.textContent).toContain(
      "1 of them are still recording"
    );
  });

  it("keeps focus and typed notes when the session list is pushed again", async () => {
    const { port } = setup();
    await load(port);

    click("[data-notes='sid-old']");
    const note = () =>
      document.querySelector<HTMLTextAreaElement>(
        "[data-detail-for='sid-old'] [data-annotate-note]"
      );
    const typed = note();
    typed?.focus();

    if (typed) {
      typed.value = "typed but not saved";
    }

    port.emit({ kind: "sw.session-list", sessions: SESSIONS });
    await flush();

    expect(note()?.value).toBe("typed but not saved");
    expect(document.activeElement).toBe(note());
  });

  it("applies the archive limits from Options and shows findings on the page", async () => {
    localStorage.setItem(
      "webblackbox.popup.export-policy",
      JSON.stringify({ maxArchiveMb: 20, recentMinutes: 5 })
    );
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    const { port } = setup();
    await load(port);

    expect(document.querySelector<HTMLElement>(".wb-sessions-notice")?.hidden).toBe(true);

    click("[data-export='sid-old']");
    await flush();
    typePassphrase("limits-secret");
    click("[data-passphrase-submit]");
    await flush();

    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ui.export",
        sid: "sid-old",
        policy: {
          ...DEFAULT_EXPORT_POLICY,
          maxArchiveBytes: 20 * 1024 * 1024,
          recentWindowMs: 300_000
        }
      })
    );

    port.emit({
      kind: "sw.export-status",
      sid: "sid-old",
      ok: true,
      privacyWarning: { findingCount: 1, summary: "jwt", findings: [] }
    });
    await flush();

    expect(alertSpy).not.toHaveBeenCalled();
    const notice = document.querySelector<HTMLElement>(".wb-sessions-notice[role='status']");
    expect(notice?.hidden).toBe(false);
    expect(notice?.textContent).toContain("jwt");
    localStorage.clear();
  });

  it("offers no Player action until a Player URL is configured", async () => {
    const { port, changeStorage } = setup({ local: {} });
    await load(port);

    expect(document.querySelector("[data-player]")).toBeNull();
    expect(document.querySelector("[data-export='sid-old']")).not.toBeNull();

    changeStorage("local", { [PLAYER_URL_KEY]: "https://player.example.com/" });
    await flush();

    expect(document.querySelector("[data-player='sid-old']")).not.toBeNull();

    changeStorage("local", { [PLAYER_URL_KEY]: "" });
    await flush();

    expect(document.querySelector("[data-player]")).toBeNull();
  });

  it("ignores a stored Player URL that is not https", async () => {
    const { port } = setup({ local: { [PLAYER_URL_KEY]: "http://player.example.com/" } });
    await load(port);

    expect(document.querySelector("[data-player]")).toBeNull();
  });

  it("opens the organization's Player when the policy sets one", async () => {
    const { port, create } = setup({
      local: { [PLAYER_URL_KEY]: "https://mine.example.com/" },
      managed: { enterprisePolicy: { playerUrl: "https://player.corp.example/qa/" } }
    });
    await load(port);

    click("[data-player='sid-old']");
    await flush();
    typePassphrase("player-secret");
    click("[data-passphrase-submit]");
    await flush();
    port.emit({ kind: "sw.export-status", sid: "sid-old", ok: true, fileName: "a.webblackbox" });
    await flush();

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ url: "https://player.corp.example/qa/", active: true });
  });

  it("opens the Player once the export of that session finished", async () => {
    const { port, create } = setup({ local: { [PLAYER_URL_KEY]: "https://player.example.com" } });
    await load(port);

    click("[data-player='sid-old']");
    await flush();
    typePassphrase("player-secret");
    click("[data-passphrase-submit]");
    await flush();

    expect(create).not.toHaveBeenCalled();

    port.emit({ kind: "sw.export-status", sid: "sid-old", ok: true, fileName: "a.webblackbox" });
    await flush();

    expect(create).toHaveBeenCalledWith({ url: "https://player.example.com/", active: true });
    // Only the page is opened: neither the archive nor the passphrase goes to the Player.
    expect(JSON.stringify(create.mock.calls)).not.toContain("player-secret");
  });

  it("edits tags and notes in the row's detail panel", async () => {
    const { port } = setup();
    await load(port);

    const detail = () => document.querySelector<HTMLElement>("[data-detail-for='sid-old']");

    expect(detail()?.hidden).toBe(true);
    click("[data-notes='sid-old']");
    expect(detail()?.hidden).toBe(false);

    const tags = detail()?.querySelector<HTMLInputElement>("[data-annotate-tags]");
    const note = detail()?.querySelector<HTMLTextAreaElement>("[data-annotate-note]");

    if (tags && note) {
      tags.value = "checkout, regression";
      note.value = "Coupon rejected";
    }

    detail()
      ?.querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "ui.annotate",
      sid: "sid-old",
      tags: ["checkout", "regression"],
      note: "Coupon rejected"
    });
  });
});
