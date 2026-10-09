import { describe, expect, it, vi } from "vitest";

import {
  loadKnownPlayerUrl,
  loadManagedPlayerUrl,
  loadPlayerUrlSetting,
  normalizePlayerUrl,
  parsePlayerUrl,
  PLAYER_URL_STORAGE_KEY,
  resolvePlayerUrl
} from "./player-url.js";

const area = (values: Record<string, unknown>) => ({ get: vi.fn(async () => values) });
const failing = () => ({
  get: vi.fn(async () => {
    throw new Error("storage unavailable");
  })
});
// Chrome can hold storage.managed back while a page opened at browser start keeps loading.
const pending = () => ({ get: vi.fn(() => new Promise<Record<string, unknown>>(() => undefined)) });

describe("player URL setting", () => {
  it.each([
    ["https://player.example.com", "https://player.example.com/"],
    ["  https://player.example.com/qa/?lang=ru  ", "https://player.example.com/qa/?lang=ru"],
    ["http://localhost:4177/", "http://localhost:4177/"],
    ["http://127.0.0.1:8080/player", "http://127.0.0.1:8080/player"],
    ["", ""],
    ["   ", ""]
  ])("accepts %j as %j", (raw, expected) => {
    expect(parsePlayerUrl(raw)).toEqual({ ok: true, value: expected });
  });

  it.each([
    "player.example.com",
    "/player",
    "http://player.example.com/",
    "http://localhost.example.com/",
    "http://192.168.1.10/",
    "ftp://player.example.com/",
    "javascript:alert(1)",
    "data:text/html,<p>x</p>",
    "chrome-extension://abc/player.html",
    "https://user:secret@player.example.com/",
    "https://"
  ])("rejects %j", (raw) => {
    expect(parsePlayerUrl(raw)).toEqual({ ok: false });
  });

  it.each([
    ["https://player.example.com", "https://player.example.com/"],
    ["http://example.com/", ""],
    [42, ""],
    [null, ""],
    [undefined, ""]
  ])("normalizes stored %j to %j", (stored, expected) => {
    expect(normalizePlayerUrl(stored)).toBe(expected);
  });

  it("lets a valid managed value win over the local one", () => {
    expect(resolvePlayerUrl("https://local.example.com/", "https://org.example.com/")).toEqual({
      url: "https://org.example.com/",
      managed: true
    });
    expect(resolvePlayerUrl("https://local.example.com/", "")).toEqual({
      url: "https://local.example.com/",
      managed: false
    });
    expect(resolvePlayerUrl("", "")).toEqual({ url: "", managed: false });
  });

  it("reads the managed value from the scoped and the flat policy layout", async () => {
    await expect(
      loadManagedPlayerUrl(area({ enterprisePolicy: { playerUrl: "https://org.example.com" } }))
    ).resolves.toBe("https://org.example.com/");
    await expect(
      loadManagedPlayerUrl(area({ playerUrl: "https://flat.example.com/" }))
    ).resolves.toBe("https://flat.example.com/");
    await expect(
      loadManagedPlayerUrl(area({ playerUrl: "http://insecure.example.com/" }))
    ).resolves.toBe("");
    await expect(loadManagedPlayerUrl(undefined)).resolves.toBe("");
    await expect(loadManagedPlayerUrl(failing())).resolves.toBe("");
  });

  it("loads the effective setting from local and managed storage", async () => {
    const local = area({ [PLAYER_URL_STORAGE_KEY]: "https://local.example.com/" });

    await expect(loadPlayerUrlSetting({ local, managed: area({}) })).resolves.toEqual({
      url: "https://local.example.com/",
      managed: false
    });
    expect(local.get).toHaveBeenCalledWith(PLAYER_URL_STORAGE_KEY);
    await expect(
      loadPlayerUrlSetting({
        local,
        managed: area({ enterprisePolicy: { playerUrl: "https://org.example.com/" } })
      })
    ).resolves.toEqual({ url: "https://org.example.com/", managed: true });
  });

  it("is empty when nothing is configured or storage fails", async () => {
    await expect(loadPlayerUrlSetting(undefined)).resolves.toEqual({ url: "", managed: false });
    await expect(loadPlayerUrlSetting({ local: failing(), managed: failing() })).resolves.toEqual({
      url: "",
      managed: false
    });
  });

  it("goes on with the local value when the managed policy does not answer", async () => {
    vi.useFakeTimers();

    try {
      const local = area({ [PLAYER_URL_STORAGE_KEY]: "https://local.example.com/" });
      const setting = loadPlayerUrlSetting({ local, managed: pending() });
      const managedUrl = loadManagedPlayerUrl(pending());

      await vi.advanceTimersByTimeAsync(3_000);

      await expect(setting).resolves.toEqual({ url: "https://local.example.com/", managed: false });
      await expect(managedUrl).resolves.toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells an unknown URL (the policy did not answer) from an unset one", async () => {
    const local = area({ [PLAYER_URL_STORAGE_KEY]: "https://local.example.com/" });

    await expect(loadKnownPlayerUrl({ local, managed: area({}) })).resolves.toBe(
      "https://local.example.com/"
    );
    await expect(loadKnownPlayerUrl({ local: area({}), managed: failing() })).resolves.toBe("");
    await expect(loadKnownPlayerUrl(undefined)).resolves.toBe("");

    vi.useFakeTimers();

    try {
      const known = loadKnownPlayerUrl({ local, managed: pending() });
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(known).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
