// Tests for the extension bundling step of the player build (scripts/lib/bundle-extension.mjs):
// zip present → copied with extension.json metadata; zip absent → no metadata, no failure.
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bundleExtensionIntoPlayer,
  findPackagedExtensionZip,
  PLAYER_EXTENSION_METADATA,
  PLAYER_EXTENSION_ZIP
} from "./bundle-extension.mjs";

let workDir = "";

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "wb-bundle-extension-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function layout(version = "0.7.0") {
  const extensionDir = join(workDir, "extension");
  const outputDir = join(extensionDir, ".output");
  const buildDir = join(workDir, "player", "build");
  await mkdir(outputDir, { recursive: true });
  await mkdir(buildDir, { recursive: true });
  const packageJson = join(extensionDir, "package.json");
  await writeFile(packageJson, JSON.stringify({ name: "@webblackbox/extension", version }));
  return { packageJson, outputDir, buildDir };
}

describe("bundleExtensionIntoPlayer", () => {
  it("copies the packaged zip and writes version/size/sha256 metadata", async () => {
    const { packageJson, outputDir, buildDir } = await layout("1.2.3");
    const zipBytes = Buffer.from("fake zip bytes");
    await writeFile(join(outputDir, "webblackboxextension-1.2.3-chrome.zip"), zipBytes);

    const result = await bundleExtensionIntoPlayer({
      extensionPackageJson: packageJson,
      extensionOutputDir: outputDir,
      playerBuildDir: buildDir,
      now: () => new Date("2026-10-07T12:00:00Z")
    });

    expect(result.bundled).toBe(true);

    const copied = await readFile(join(buildDir, "extension", PLAYER_EXTENSION_ZIP));
    expect(copied.equals(zipBytes)).toBe(true);

    const metadata = JSON.parse(
      await readFile(join(buildDir, "extension", PLAYER_EXTENSION_METADATA), "utf8")
    );
    expect(metadata).toEqual({
      version: "1.2.3",
      file: PLAYER_EXTENSION_ZIP,
      size: zipBytes.byteLength,
      sha256: "76d7ad9b5902020461ee993221ed8a21cd98c418d85d13a3164cba060948d4fb",
      builtAt: "2026-10-07T12:00:00.000Z"
    });
  });

  it("succeeds without the metadata when the extension was never packaged", async () => {
    const { packageJson, outputDir, buildDir } = await layout();

    const result = await bundleExtensionIntoPlayer({
      extensionPackageJson: packageJson,
      extensionOutputDir: outputDir,
      playerBuildDir: buildDir
    });

    expect(result).toEqual({ bundled: false, version: "0.7.0" });
    await expect(
      readFile(join(buildDir, "extension", PLAYER_EXTENSION_METADATA), "utf8")
    ).rejects.toThrow();
    await expect(readFile(join(buildDir, "extension", PLAYER_EXTENSION_ZIP))).rejects.toThrow();
  });

  it("removes a stale bundled copy when the zip is gone", async () => {
    const { packageJson, outputDir, buildDir } = await layout();
    await writeFile(join(outputDir, "webblackboxextension-0.7.0-chrome.zip"), "zip");
    await bundleExtensionIntoPlayer({
      extensionPackageJson: packageJson,
      extensionOutputDir: outputDir,
      playerBuildDir: buildDir
    });
    await rm(join(outputDir, "webblackboxextension-0.7.0-chrome.zip"));

    const result = await bundleExtensionIntoPlayer({
      extensionPackageJson: packageJson,
      extensionOutputDir: outputDir,
      playerBuildDir: buildDir
    });

    expect(result.bundled).toBe(false);
    await expect(
      readFile(join(buildDir, "extension", PLAYER_EXTENSION_METADATA), "utf8")
    ).rejects.toThrow();
  });

  it("does not ship a zip left over from another extension version", async () => {
    const { packageJson, outputDir, buildDir } = await layout("9.9.9");
    await writeFile(join(outputDir, "webblackboxextension-0.6.0-chrome.zip"), "old zip");

    const result = await bundleExtensionIntoPlayer({
      extensionPackageJson: packageJson,
      extensionOutputDir: outputDir,
      playerBuildDir: buildDir
    });

    expect(result).toEqual({ bundled: false, version: "9.9.9" });
    await expect(readFile(join(buildDir, "extension", PLAYER_EXTENSION_ZIP))).rejects.toThrow();
  });

  it("fails loudly when the extension package.json has no version", async () => {
    const { outputDir, buildDir } = await layout();
    const packageJson = join(workDir, "extension", "package.json");
    await writeFile(packageJson, JSON.stringify({ name: "@webblackbox/extension" }));

    await expect(
      bundleExtensionIntoPlayer({
        extensionPackageJson: packageJson,
        extensionOutputDir: outputDir,
        playerBuildDir: buildDir
      })
    ).rejects.toThrow(/Missing version/);
  });
});

describe("findPackagedExtensionZip", () => {
  it("returns null when the output directory does not exist", async () => {
    await expect(findPackagedExtensionZip(join(workDir, "nope"), "0.7.0")).resolves.toBeNull();
  });

  it("finds WXT's zip of the default build only", async () => {
    const { outputDir } = await layout();
    await writeFile(join(outputDir, "webblackboxextension-0.7.0-chrome-store-safe.zip"), "zip");
    await expect(findPackagedExtensionZip(outputDir, "0.7.0")).resolves.toBeNull();

    await writeFile(join(outputDir, "webblackboxextension-0.7.0-chrome.zip"), "zip");
    await expect(findPackagedExtensionZip(outputDir, "0.7.0")).resolves.toBe(
      join(outputDir, "webblackboxextension-0.7.0-chrome.zip")
    );

    await writeFile(join(outputDir, "other-0.7.0-chrome.zip"), "zip");
    await expect(findPackagedExtensionZip(outputDir, "0.7.0")).rejects.toThrow(/More than one/);
  });
});
