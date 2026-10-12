import { vi } from "vitest";

/** Shared fakes for the popup tests (jsdom): a runtime port, a chrome stub and DOM getters. */

type PortMessageHandler = (message: unknown) => void;
type PortPostMessageHandler = (message: unknown, port: FakePort) => void;

export class FakePort {
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

  private readonly disconnectHandlers = new Set<() => void>();

  readonly onDisconnect = {
    addListener: (handler: () => void): void => {
      this.disconnectHandlers.add(handler);
    },
    removeListener: (handler: () => void): void => {
      this.disconnectHandlers.delete(handler);
    }
  };

  /** Simulates the service worker going away. */
  disconnect(): void {
    for (const handler of this.disconnectHandlers) {
      handler();
    }
  }

  emit(message: unknown): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }
}

export type ChromeStub = {
  tabsCreate: ReturnType<typeof vi.fn>;
  tabsSendMessage: ReturnType<typeof vi.fn>;
  /** `chrome.storage.local.set`; writes land in the stub's storage. Absent without storage. */
  storageSet?: ReturnType<typeof vi.fn>;
};

export function installChromeStub(
  port: FakePort,
  options: {
    sendMessage?: ReturnType<typeof vi.fn>;
    tabsSendMessage?: ReturnType<typeof vi.fn>;
    onQuery?: () => void | Promise<void>;
    /** `chrome.storage.local` contents; without it the stub has no storage at all. */
    storage?: Record<string, unknown>;
  } = {}
): ChromeStub {
  const query = vi.fn(async () => {
    await options.onQuery?.();
    return [{ id: 17, active: true, url: "https://example.com", lastAccessed: Date.now() }];
  });
  const tabsCreate = vi.fn(async (details: { url?: string; active?: boolean }) => ({
    id: 99,
    active: details.active ?? true,
    url: details.url
  }));
  const tabsSendMessage = options.tabsSendMessage ?? vi.fn(async () => undefined);
  const stored = options.storage;
  const storageSet = stored
    ? vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(stored, items);
      })
    : undefined;
  const storage =
    stored && storageSet
      ? {
          local: {
            get: vi.fn(async (keys?: string | string[]) => {
              const wanted = keys === undefined ? Object.keys(stored) : [keys].flat();
              return Object.fromEntries(
                wanted.filter((key) => key in stored).map((key) => [key, stored[key]])
              );
            }),
            set: storageSet
          }
        }
      : undefined;

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    writable: true,
    value: {
      runtime: {
        connect: vi.fn(() => port),
        getURL: vi.fn((path: string) => `chrome-extension://test-extension/${path}`),
        getManifest: vi.fn(() => ({ version: "0.1.1" })),
        ...(options.sendMessage ? { sendMessage: options.sendMessage } : {})
      },
      tabs: { create: tabsCreate, query, sendMessage: tabsSendMessage },
      ...(storage ? { storage } : {})
    }
  });

  return { tabsCreate, tabsSendMessage, ...(storageSet ? { storageSet } : {}) };
}

export async function flushPopup(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export async function flushPopupWithFakeTimers(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
}

export async function importPopupModule(): Promise<void> {
  vi.resetModules();
  await import("./index.js");
  await flushPopup();
}

export async function importPopupModuleWithFakeTimers(): Promise<void> {
  vi.resetModules();
  await import("./index.js");
  await flushPopupWithFakeTimers();
}

export function resetPopupDom(): void {
  document.body.innerHTML = `<main id="popup-root"></main>`;
  localStorage.clear();
}

export function query<TElement extends Element>(selector: string): TElement {
  const element = document.querySelector<TElement>(selector);

  if (!element) {
    throw new Error(`missing ${selector}`);
  }

  return element;
}

export const getButton = (action: string): HTMLButtonElement =>
  query<HTMLButtonElement>(`[data-action='${action}']`);

export const getStatusLine = (): HTMLElement => query<HTMLElement>(".wb-popup__status");

/** Messages the popup posted on its port, of one kind. */
export function postedOfKind(port: FakePort, kind: string): unknown[] {
  return port.postMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => (message as { kind?: unknown }).kind === kind);
}

export function stoppedSession(sid: string, mode: "lite" | "full" = "full", tabId = 17) {
  return { sid, tabId, mode, startedAt: Date.now(), active: false };
}

export function activeSession(sid: string, mode: "lite" | "full" = "full", tabId = 17) {
  return { sid, tabId, mode, startedAt: Date.now(), active: true };
}

/** Opens the passphrase dialog from Export, optionally types a passphrase, and submits. */
export async function submitExport(passphrase?: string, flush = flushPopup): Promise<void> {
  getButton("export").click();
  await flush();

  if (passphrase !== undefined) {
    for (const selector of ["#wb-passphrase-input", "#wb-passphrase-confirm"]) {
      const input = query<HTMLInputElement>(selector);
      input.value = passphrase;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  query<HTMLButtonElement>("[data-passphrase-submit]").click();
  await flush();
}
