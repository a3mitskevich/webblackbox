import { afterEach, describe, expect, it, vi } from "vitest";

import type { RegisteredContentScript } from "../shared/chrome-api.js";
import { CONTENT_INJECTION_STORAGE_KEY, CONTENT_SCRIPT_ID } from "../shared/content-injection.js";
import {
  createContentInjectionController,
  injectContentScriptIntoFrame,
  isInjectableFrameUrl
} from "./content-injection.js";

type FakeOptions = {
  stored?: unknown;
  hostPermissions?: string[];
  registered?: string[];
  failRegister?: boolean;
};

function createFakeChrome(options: FakeOptions = {}) {
  const storage: Record<string, unknown> = { [CONTENT_INJECTION_STORAGE_KEY]: options.stored };
  let registered = [...(options.registered ?? [])];
  const calls: string[] = [];
  const registerContentScripts = vi.fn(async (scripts: RegisteredContentScript[]) => {
    calls.push("register");

    if (options.failRegister) {
      throw new Error("register failed");
    }

    for (const script of scripts) {
      if (registered.includes(script.id)) {
        throw new Error(`Duplicate script ID '${script.id}'`);
      }
    }

    // Lets an overlapping sync observe the in-between state, as Chrome's async API would.
    await new Promise((resolve) => setTimeout(resolve, 0));
    registered = [...registered, ...scripts.map((script) => script.id)];
  });
  const unregisterContentScripts = vi.fn(async (filter?: { ids?: string[] }) => {
    calls.push("unregister");
    registered = registered.filter((id) => !filter?.ids?.includes(id));
  });
  const getRegisteredContentScripts = vi.fn(async (filter?: { ids?: string[] }) =>
    registered.filter((id) => !filter?.ids || filter.ids.includes(id)).map((id) => ({ id }))
  );

  return {
    calls,
    storage,
    registered: () => registered,
    registerContentScripts,
    api: {
      runtime: {
        connect: vi.fn(),
        getURL: (path: string) => path,
        getManifest: () => ({ host_permissions: options.hostPermissions ?? ["<all_urls>"] }),
        onConnect: { addListener: vi.fn() },
        onInstalled: { addListener: vi.fn() },
        onMessage: { addListener: vi.fn() },
        sendMessage: vi.fn()
      },
      scripting: {
        executeScript: vi.fn(async () => undefined),
        registerContentScripts,
        unregisterContentScripts,
        getRegisteredContentScripts
      },
      storage: {
        local: {
          get: vi.fn(async (key?: unknown) =>
            typeof key === "string" ? { [key]: storage[key] } : { ...storage }
          ),
          set: vi.fn(async () => undefined)
        }
      }
    }
  };
}

describe("content injection controller", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers the all-sites script by default", async () => {
    const chrome = createFakeChrome();
    const controller = createContentInjectionController(chrome.api);

    await expect(controller.sync()).resolves.toBe("always");
    expect(chrome.registered()).toEqual([CONTENT_SCRIPT_ID]);
    expect(controller.currentMode()).toBe("always");
  });

  it("unregisters it when injection waits for Start", async () => {
    const chrome = createFakeChrome({ stored: "on-start", registered: [CONTENT_SCRIPT_ID] });
    const controller = createContentInjectionController(chrome.api);

    await expect(controller.sync()).resolves.toBe("on-start");
    expect(chrome.registered()).toEqual([]);
    expect(controller.currentMode()).toBe("on-start");
  });

  it("follows a changed setting and leaves a matching registration alone", async () => {
    const chrome = createFakeChrome({ registered: [CONTENT_SCRIPT_ID] });
    const controller = createContentInjectionController(chrome.api);

    await controller.sync();
    expect(chrome.calls).toEqual([]);

    chrome.storage[CONTENT_INJECTION_STORAGE_KEY] = "on-start";
    await controller.sync();
    chrome.storage[CONTENT_INJECTION_STORAGE_KEY] = "always";
    await controller.sync();

    expect(chrome.calls).toEqual(["unregister", "register"]);
    expect(chrome.registered()).toEqual([CONTENT_SCRIPT_ID]);
  });

  it("serializes overlapping syncs so the script is registered once", async () => {
    const chrome = createFakeChrome();
    const controller = createContentInjectionController(chrome.api);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await Promise.all([controller.sync(), controller.sync(), controller.sync()]);

    expect(chrome.registerContentScripts).toHaveBeenCalledTimes(1);
    expect(chrome.registered()).toEqual([CONTENT_SCRIPT_ID]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("never registers without host access to every site (store-safe build)", async () => {
    const chrome = createFakeChrome({ hostPermissions: [] });
    const controller = createContentInjectionController(chrome.api);

    expect(controller.currentMode()).toBe("on-start");
    await expect(controller.sync()).resolves.toBe("on-start");
    expect(chrome.calls).toEqual([]);
  });

  it("reports a failed registration and tries again on the next trigger", async () => {
    const chrome = createFakeChrome({ failRegister: true });
    const controller = createContentInjectionController(chrome.api);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(controller.sync()).resolves.toBe("always");
    expect(warn).toHaveBeenCalledTimes(1);

    await controller.sync();
    expect(chrome.registerContentScripts).toHaveBeenCalledTimes(2);
  });

  it("injects one committed frame as early as possible", async () => {
    const chrome = createFakeChrome();

    await injectContentScriptIntoFrame(chrome.api, 7, 3);

    expect(chrome.api.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, frameIds: [3] },
      world: "ISOLATED",
      files: ["content.js"],
      injectImmediately: true
    });
  });

  it("swallows injection failures (frame gone, restricted page)", async () => {
    const chrome = createFakeChrome();
    chrome.api.scripting.executeScript.mockRejectedValueOnce(new Error("Frame removed"));

    await expect(injectContentScriptIntoFrame(chrome.api, 7, 3)).resolves.toBeUndefined();
  });

  it("only targets frame URLs the all-sites registration would match", () => {
    expect(isInjectableFrameUrl("https://example.com/")).toBe(true);
    expect(isInjectableFrameUrl("http://127.0.0.1:8080/a")).toBe(true);
    expect(isInjectableFrameUrl("file:///tmp/page.html")).toBe(true);
    expect(isInjectableFrameUrl("about:blank")).toBe(false);
    expect(isInjectableFrameUrl("chrome://settings")).toBe(false);
    expect(isInjectableFrameUrl("data:text/html,hi")).toBe(false);
  });
});
