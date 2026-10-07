// Ships the packaged Chrome extension inside the player build: copies
// apps/extension/dist/webblackbox-<version>-chrome.zip to <build>/extension/webblackbox-chrome.zip
// and writes extension/extension.json ({ version, file, size, sha256, builtAt }). The guide view
// reads that metadata; without it the guide explains that this build does not bundle the extension.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PLAYER_EXTENSION_DIR = "extension";
/** The fixed in-build name: the download URL never changes across extension versions. */
export const PLAYER_EXTENSION_ZIP = "webblackbox-chrome.zip";
export const PLAYER_EXTENSION_METADATA = "extension.json";

const PACKAGED_ZIP_PATTERN = /^webblackbox-(.+)-chrome\.zip$/u;

/**
 * The zip `pnpm --filter @webblackbox/extension package:chrome` wrote for `version`
 * (`webblackbox-<version>-chrome.zip`), or — when only an older packaging run is left — the newest
 * `webblackbox-*-chrome.zip` in the directory. Returns null when nothing was ever packaged.
 */
export async function findPackagedExtensionZip(distDir, version) {
  const exact = join(distDir, `webblackbox-${version}-chrome.zip`);

  try {
    await stat(exact);
    return exact;
  } catch {
    // Fall through to the stale-artifact search.
  }

  let entries;

  try {
    entries = await readdir(distDir);
  } catch {
    return null;
  }

  const candidates = [];

  for (const name of entries) {
    const match = PACKAGED_ZIP_PATTERN.exec(name);

    if (!match) {
      continue;
    }

    try {
      const path = join(distDir, name);
      const info = await stat(path);
      candidates.push({ path, version: match[1], mtimeMs: info.mtimeMs });
    } catch {
      // A race with a concurrent packaging run: skip the vanished entry.
    }
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0] ?? null;
}

/**
 * Copies the packaged extension into the player build and writes the metadata next to it. With no
 * packaged zip the build stays valid: any stale copy in the output is removed and the result is
 * `{ bundled: false }` (the caller prints the warning).
 */
export async function bundleExtensionIntoPlayer({
  extensionPackageJson,
  extensionDistDir,
  playerBuildDir,
  now = () => new Date()
}) {
  const packageJson = JSON.parse(await readFile(extensionPackageJson, "utf8"));
  const version =
    typeof packageJson.version === "string" && packageJson.version.length > 0
      ? packageJson.version
      : null;

  if (!version) {
    throw new Error(`Missing version in ${extensionPackageJson}`);
  }

  const packaged = await findPackagedExtensionZip(extensionDistDir, version);
  const targetDir = join(playerBuildDir, PLAYER_EXTENSION_DIR);

  if (!packaged) {
    await rm(join(targetDir, PLAYER_EXTENSION_ZIP), { force: true });
    await rm(join(targetDir, PLAYER_EXTENSION_METADATA), { force: true });
    return { bundled: false, version };
  }

  const bytes = await readFile(typeof packaged === "string" ? packaged : packaged.path);
  const zipVersion = typeof packaged === "string" ? version : packaged.version;
  await mkdir(targetDir, { recursive: true });
  await writeFile(join(targetDir, PLAYER_EXTENSION_ZIP), bytes);

  const metadata = {
    version: zipVersion,
    file: PLAYER_EXTENSION_ZIP,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    builtAt: now().toISOString()
  };
  await writeFile(
    join(targetDir, PLAYER_EXTENSION_METADATA),
    `${JSON.stringify(metadata, null, 2)}\n`
  );

  return { bundled: true, metadata };
}
