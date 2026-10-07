import { describe, expect, it, vi } from "vitest";

import {
  EXTENSION_METADATA_URL,
  fetchExtensionBundleMetadata,
  parseExtensionBundleMetadata
} from "./metadata.js";

const VALID = {
  version: "0.7.0",
  file: "webblackbox-chrome.zip",
  size: 123_456,
  sha256: "b".repeat(64),
  builtAt: "2026-10-07T00:00:00.000Z"
};

describe("parseExtensionBundleMetadata", () => {
  it("accepts the build script's metadata", () => {
    expect(parseExtensionBundleMetadata(VALID)).toEqual(VALID);
  });

  it.each([
    ["null", null],
    ["an array", [VALID]],
    ["a wrong file name", { ...VALID, file: "other.zip" }],
    ["a non-hex sha256", { ...VALID, sha256: "z".repeat(64) }],
    ["an empty version", { ...VALID, version: "" }],
    ["a non-positive size", { ...VALID, size: 0 }],
    ["an unparseable builtAt", { ...VALID, builtAt: "soon" }]
  ])("rejects %s", (_label, value) => {
    expect(parseExtensionBundleMetadata(value)).toBeNull();
  });
});

describe("fetchExtensionBundleMetadata", () => {
  it("reads the metadata same-origin, relative to the player", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(VALID), { status: 200 }));

    const metadata = await fetchExtensionBundleMetadata(fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledWith(EXTENSION_METADATA_URL);
    expect(metadata).toEqual(VALID);
  });

  it("returns null on a 404, a network error or invalid JSON", async () => {
    const notFound = vi.fn(async () => new Response("nope", { status: 404 }));
    const down = vi.fn(async () => Promise.reject(new Error("connection refused")));
    const garbage = vi.fn(async () => new Response("<html>", { status: 200 }));

    await expect(
      fetchExtensionBundleMetadata(notFound as unknown as typeof fetch)
    ).resolves.toBeNull();
    await expect(fetchExtensionBundleMetadata(down as unknown as typeof fetch)).resolves.toBeNull();
    await expect(
      fetchExtensionBundleMetadata(garbage as unknown as typeof fetch)
    ).resolves.toBeNull();
  });
});
