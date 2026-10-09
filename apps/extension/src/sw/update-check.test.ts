import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EXTENSION_UPDATE_DISMISSED_STORAGE_KEY,
  EXTENSION_UPDATE_STORAGE_KEY
} from "../shared/extension-update.js";
import { PLAYER_URL_STORAGE_KEY } from "../shared/player-url.js";
import {
  createExtensionUpdateChecker,
  EXTENSION_UPDATE_ALARM,
  EXTENSION_UPDATE_CHECK_INTERVAL_MINUTES,
  UPDATE_AVAILABLE_BADGE,
  type ExtensionUpdateCheckDeps
} from "./update-check.js";

const PLAYER_URL = "https://player.example.com/qa/";
const METADATA_URL = "https://player.example.com/qa/extension/extension.json";
const NOW = 1_760_000_000_000;

function createStorage(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));

  return {
    values,
    get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) => {
      const wanted = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : [];
      return Object.fromEntries(
        wanted.filter((key) => values.has(key)).map((key) => [key, values.get(key)])
      );
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) {
        values.set(key, value);
      }
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of [keys].flat()) {
        values.delete(key);
      }
    })
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function createHarness(
  options: {
    playerUrl?: string;
    fetch?: ExtensionUpdateCheckDeps["fetch"];
    storage?: Record<string, unknown>;
    installedVersion?: string;
    alarms?: ExtensionUpdateCheckDeps["alarms"];
  } = {}
) {
  const storage = createStorage(options.storage);
  const fetchImpl = options.fetch ?? vi.fn(async () => jsonResponse({ version: "0.8.0" }));
  const refreshBadge = vi.fn(async () => undefined);
  const loadPlayerUrl = vi.fn(async () => options.playerUrl ?? PLAYER_URL);
  const checker = createExtensionUpdateChecker({
    storageLocal: storage,
    alarms: options.alarms,
    loadPlayerUrl,
    fetch: fetchImpl,
    installedVersion: options.installedVersion ?? "0.7.0",
    now: () => NOW,
    refreshBadge
  });

  return { checker, storage, fetch: fetchImpl, refreshBadge, loadPlayerUrl };
}

const stored = (latestVersion: string, playerUrl = PLAYER_URL) => ({
  latestVersion,
  checkedAt: NOW - 1_000,
  playerUrl
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("extension update check", () => {
  it("asks the Player with a plain, credential-less GET and stores a newer version", async () => {
    const harness = createHarness();

    await harness.checker.check();

    expect(harness.fetch).toHaveBeenCalledTimes(1);
    expect(harness.fetch).toHaveBeenCalledWith(
      METADATA_URL,
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer"
      })
    );
    expect(harness.storage.values.get(EXTENSION_UPDATE_STORAGE_KEY)).toEqual({
      latestVersion: "0.8.0",
      checkedAt: NOW,
      playerUrl: PLAYER_URL
    });
    expect(harness.refreshBadge).toHaveBeenCalledTimes(1);
    await expect(harness.checker.badge()).resolves.toEqual(UPDATE_AVAILABLE_BADGE);
  });

  it.each([
    ["the same", "0.7.0"],
    ["an older", "0.6.0"]
  ])("stores %s version without a badge", async (_label, version) => {
    const harness = createHarness({
      fetch: vi.fn(async () => jsonResponse({ version })),
      storage: { [EXTENSION_UPDATE_STORAGE_KEY]: stored("0.8.0") }
    });

    await harness.checker.check();

    expect(harness.storage.values.get(EXTENSION_UPDATE_STORAGE_KEY)).toMatchObject({
      latestVersion: version
    });
    await expect(harness.checker.badge()).resolves.toBeNull();
  });

  it.each([
    ["invalid JSON", async () => new Response("<html>", { status: 200 })],
    ["a non-version", async () => jsonResponse({ version: "latest" })],
    ["an HTTP error", async () => jsonResponse({ version: "0.9.0" }, 404)],
    [
      "a network error",
      async () => {
        throw new TypeError("Failed to fetch");
      }
    ]
  ])("keeps the last answer on %s", async (_label, fetchImpl) => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const harness = createHarness({
      fetch: vi.fn(fetchImpl),
      storage: { [EXTENSION_UPDATE_STORAGE_KEY]: stored("0.8.0") }
    });

    await expect(harness.checker.check()).resolves.toBeUndefined();

    expect(harness.storage.values.get(EXTENSION_UPDATE_STORAGE_KEY)).toEqual(stored("0.8.0"));
    expect(harness.refreshBadge).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a Player URL and forgets an answer from an earlier Player", async () => {
    const harness = createHarness({
      playerUrl: "",
      storage: { [EXTENSION_UPDATE_STORAGE_KEY]: stored("0.8.0") }
    });

    await harness.checker.check();

    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.storage.values.has(EXTENSION_UPDATE_STORAGE_KEY)).toBe(false);
    expect(harness.refreshBadge).toHaveBeenCalledTimes(1);
  });

  it("forgets an answer from another Player when the new one cannot be reached", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const harness = createHarness({
      fetch: vi.fn(async () => {
        throw new TypeError("CORS");
      }),
      storage: {
        [EXTENSION_UPDATE_STORAGE_KEY]: stored("0.8.0", "https://old-player.example.com/")
      }
    });

    await harness.checker.check();

    expect(harness.storage.values.has(EXTENSION_UPDATE_STORAGE_KEY)).toBe(false);
  });

  it("aborts a request that does not answer in time", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const fetchImpl = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        })
    );
    const harness = createHarness({ fetch: fetchImpl });

    const done = harness.checker.check();
    await vi.advanceTimersByTimeAsync(10_000);
    await done;

    expect(harness.storage.values.has(EXTENSION_UPDATE_STORAGE_KEY)).toBe(false);
    expect(harness.refreshBadge).toHaveBeenCalledTimes(1);
  });

  it("runs once more after a check in flight, however many requests came in", async () => {
    const harness = createHarness();

    await Promise.all([harness.checker.check(), harness.checker.check(), harness.checker.check()]);
    expect(harness.fetch).toHaveBeenCalledTimes(2);

    await harness.checker.check();
    expect(harness.fetch).toHaveBeenCalledTimes(3);
  });

  it("does not lose a Player URL set while a check that read the old one is running", async () => {
    let releaseStartupRead: (url: string) => void = () => undefined;
    const harness = createHarness();
    harness.loadPlayerUrl
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            releaseStartupRead = resolve;
          })
      )
      .mockResolvedValue(PLAYER_URL);

    const startup = harness.checker.check();
    harness.checker.handleStorageChange({ [PLAYER_URL_STORAGE_KEY]: {} }, "local");
    releaseStartupRead("");
    await startup;
    await vi.waitFor(() => {
      expect(harness.storage.values.get(EXTENSION_UPDATE_STORAGE_KEY)).toMatchObject({
        latestVersion: "0.8.0"
      });
    });
    expect(harness.fetch).toHaveBeenCalledTimes(1);
  });

  it("never rejects, even when storage and the badge fail", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const harness = createHarness();
    harness.storage.set.mockRejectedValue(new Error("quota"));
    harness.refreshBadge.mockRejectedValue(new Error("no action"));

    await expect(harness.checker.check()).resolves.toBeUndefined();
  });

  it("shows no badge for a dismissed version, and again for a later one", async () => {
    const harness = createHarness({
      storage: {
        [EXTENSION_UPDATE_STORAGE_KEY]: stored("0.8.0"),
        [EXTENSION_UPDATE_DISMISSED_STORAGE_KEY]: "0.8.0"
      }
    });

    await expect(harness.checker.badge()).resolves.toBeNull();

    harness.storage.values.set(EXTENSION_UPDATE_STORAGE_KEY, stored("0.9.0"));
    await expect(harness.checker.badge()).resolves.toEqual(UPDATE_AVAILABLE_BADGE);
  });

  it("re-checks on a Player URL or policy change and re-badges on a new answer or dismissal", async () => {
    const harness = createHarness();

    harness.checker.handleStorageChange({ [PLAYER_URL_STORAGE_KEY]: {} }, "local");
    harness.checker.handleStorageChange({ enterprisePolicy: {} }, "managed");
    await harness.checker.check();
    expect(harness.loadPlayerUrl).toHaveBeenCalledTimes(2);
    harness.loadPlayerUrl.mockClear();
    harness.refreshBadge.mockClear();

    harness.checker.handleStorageChange({ [EXTENSION_UPDATE_DISMISSED_STORAGE_KEY]: {} }, "local");
    harness.checker.handleStorageChange({ [EXTENSION_UPDATE_STORAGE_KEY]: {} }, "local");
    harness.checker.handleStorageChange({ unrelated: {} }, "local");
    harness.checker.handleStorageChange({ [PLAYER_URL_STORAGE_KEY]: {} }, "session");

    expect(harness.refreshBadge).toHaveBeenCalledTimes(2);
    expect(harness.loadPlayerUrl).not.toHaveBeenCalled();
  });
});

describe("extension update alarm", () => {
  it("creates the periodic alarm once", async () => {
    const create = vi.fn();
    const get = vi.fn(async () => undefined);
    const harness = createHarness({ alarms: { get, create } });

    await harness.checker.ensureAlarm();

    expect(create).toHaveBeenCalledWith(EXTENSION_UPDATE_ALARM, {
      delayInMinutes: EXTENSION_UPDATE_CHECK_INTERVAL_MINUTES,
      periodInMinutes: EXTENSION_UPDATE_CHECK_INTERVAL_MINUTES
    });
  });

  it("keeps an existing alarm, so worker restarts do not postpone it", async () => {
    const create = vi.fn();
    const get = vi.fn(async () => ({
      name: EXTENSION_UPDATE_ALARM,
      periodInMinutes: EXTENSION_UPDATE_CHECK_INTERVAL_MINUTES
    }));
    const harness = createHarness({ alarms: { get, create } });

    await harness.checker.ensureAlarm();

    expect(create).not.toHaveBeenCalled();
  });

  it("tolerates a missing or failing alarms API", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    await expect(createHarness().checker.ensureAlarm()).resolves.toBeUndefined();

    const failing = createHarness({
      alarms: {
        get: vi.fn(async () => {
          throw new Error("no alarms");
        }),
        create: vi.fn()
      }
    });
    await expect(failing.checker.ensureAlarm()).resolves.toBeUndefined();
  });
});
