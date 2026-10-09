import { describe, expect, it, vi } from "vitest";

import {
  compareChromeVersions,
  EXTENSION_UPDATE_DISMISSED_STORAGE_KEY,
  EXTENSION_UPDATE_STORAGE_KEY,
  isNewerVersion,
  loadExtensionUpdateNotice,
  normalizeExtensionUpdateState,
  parseChromeVersion,
  parseExtensionMetadataVersion,
  resolveExtensionMetadataUrl,
  resolveExtensionUpdateNotice
} from "./extension-update.js";

const STATE = {
  latestVersion: "0.8.0",
  checkedAt: 1_760_000_000_000,
  playerUrl: "https://player.example.com/"
};

describe("Chrome version strings", () => {
  it.each([
    ["1", [1]],
    ["0.7.0", [0, 7, 0]],
    ["1.2.3.4", [1, 2, 3, 4]],
    ["65535.0", [65535, 0]]
  ])("parses %j", (raw, parts) => {
    expect(parseChromeVersion(raw)).toEqual(parts);
  });

  it.each([
    "",
    "1.2.3.4.5",
    "01.2",
    "1.02",
    "1..2",
    ".1",
    "1.",
    "v1.2",
    "1.2-beta",
    "1.2.3 ",
    "65536",
    "1e3",
    42,
    null,
    undefined,
    { version: "1.0" }
  ])("rejects %j", (raw) => {
    expect(parseChromeVersion(raw)).toBeNull();
  });

  it("compares numerically per part, missing parts as zero", () => {
    expect(compareChromeVersions([0, 10, 0], [0, 9, 9])).toBeGreaterThan(0);
    expect(compareChromeVersions([1, 2], [1, 2, 0, 0])).toBe(0);
    expect(compareChromeVersions([1, 2], [1, 2, 0, 1])).toBeLessThan(0);
    expect(compareChromeVersions([2], [1, 65535])).toBeGreaterThan(0);
  });

  it.each([
    ["0.8.0", "0.7.0", true],
    ["0.10.0", "0.9.0", true],
    ["0.7.0.1", "0.7.0", true],
    ["0.7.0", "0.7.0", false],
    ["0.7", "0.7.0", false],
    ["0.6.9", "0.7.0", false],
    ["garbage", "0.7.0", false],
    ["0.8.0", "dev", false]
  ])("isNewerVersion(%j, %j) = %j", (candidate, installed, expected) => {
    expect(isNewerVersion(candidate, installed)).toBe(expected);
  });
});

describe("metadata URL", () => {
  it.each([
    ["https://player.example.com", "https://player.example.com/extension/extension.json"],
    ["https://player.example.com/", "https://player.example.com/extension/extension.json"],
    ["https://host.example.com/qa", "https://host.example.com/qa/extension/extension.json"],
    ["https://host.example.com/qa/", "https://host.example.com/qa/extension/extension.json"],
    [
      "https://host.example.com/qa/index.html",
      "https://host.example.com/qa/extension/extension.json"
    ],
    [
      "https://host.example.com/qa/?lang=ru#t=1",
      "https://host.example.com/qa/extension/extension.json"
    ],
    ["http://localhost:4177/", "http://localhost:4177/extension/extension.json"]
  ])("resolves %j to %j", (playerUrl, expected) => {
    expect(resolveExtensionMetadataUrl(playerUrl)).toBe(expected);
  });

  it("stays on the Player's origin", () => {
    const url = resolveExtensionMetadataUrl("https://player.example.com/a/b/");
    expect(new URL(url ?? "").origin).toBe("https://player.example.com");
  });

  it("gives null for an unparsable URL", () => {
    expect(resolveExtensionMetadataUrl("not a url")).toBeNull();
  });
});

describe("fetched metadata", () => {
  it("takes a valid version and ignores the other fields", () => {
    expect(
      parseExtensionMetadataVersion({
        version: "0.8.0",
        file: "webblackbox-chrome.zip",
        size: 1,
        sha256: "x",
        builtAt: "2026-10-01T00:00:00Z"
      })
    ).toBe("0.8.0");
    expect(parseExtensionMetadataVersion({ version: "0.8.0" })).toBe("0.8.0");
  });

  it.each([
    null,
    "0.8.0",
    ["0.8.0"],
    {},
    { version: 8 },
    { version: "0.8.0-beta" },
    { version: "<img src=x onerror=alert(1)>" }
  ])("rejects %j", (body) => {
    expect(parseExtensionMetadataVersion(body)).toBeNull();
  });
});

describe("stored state and the notice", () => {
  it("normalizes a stored state", () => {
    expect(normalizeExtensionUpdateState(STATE)).toEqual(STATE);
    expect(normalizeExtensionUpdateState({ ...STATE, extra: 1 })).toEqual(STATE);
  });

  it.each([
    undefined,
    null,
    [],
    { ...STATE, latestVersion: "x" },
    { ...STATE, checkedAt: "now" },
    { ...STATE, checkedAt: Number.NaN },
    { ...STATE, playerUrl: 1 }
  ])("drops a malformed state %j", (value) => {
    expect(normalizeExtensionUpdateState(value)).toBeNull();
  });

  it("shows a newer version that was not dismissed", () => {
    expect(resolveExtensionUpdateNotice(STATE, undefined, "0.7.0")).toEqual({
      latestVersion: "0.8.0",
      installedVersion: "0.7.0",
      playerUrl: "https://player.example.com/"
    });
  });

  it("hides the dismissed version but shows a later one", () => {
    expect(resolveExtensionUpdateNotice(STATE, "0.8.0", "0.7.0")).toBeNull();
    expect(
      resolveExtensionUpdateNotice({ ...STATE, latestVersion: "0.9.0" }, "0.8.0", "0.7.0")
    ).not.toBeNull();
  });

  it("hides the notice once the installed version caught up", () => {
    expect(resolveExtensionUpdateNotice(STATE, undefined, "0.8.0")).toBeNull();
    expect(resolveExtensionUpdateNotice(STATE, undefined, "0.9.0")).toBeNull();
    expect(resolveExtensionUpdateNotice(null, undefined, "0.7.0")).toBeNull();
  });

  it("loads the notice from storage and treats a failing read as none", async () => {
    const storage = {
      get: vi.fn(async () => ({
        [EXTENSION_UPDATE_STORAGE_KEY]: STATE,
        [EXTENSION_UPDATE_DISMISSED_STORAGE_KEY]: "0.7.5"
      }))
    };

    await expect(loadExtensionUpdateNotice(storage, "0.7.0")).resolves.toMatchObject({
      latestVersion: "0.8.0"
    });
    await expect(
      loadExtensionUpdateNotice(
        {
          get: vi.fn(async () => {
            throw new Error("storage unavailable");
          })
        },
        "0.7.0"
      )
    ).resolves.toBeNull();
    await expect(loadExtensionUpdateNotice(undefined, "0.7.0")).resolves.toBeNull();
  });
});
