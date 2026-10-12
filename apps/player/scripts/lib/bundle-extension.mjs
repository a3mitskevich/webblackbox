// Ships the packaged Chrome extension inside the player build: copies the zip `wxt zip` wrote to
// apps/extension/.output/<name>-<version>-chrome.zip to <build>/extension/webblackbox-chrome.zip
// and writes extension/extension.json ({ version, file, size, sha256, builtAt }). The guide view
// reads that metadata; without it the guide explains that this build does not bundle the extension.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PLAYER_EXTENSION_DIR = "extension";
/** The fixed in-build name: the download URL never changes across extension versions. */
export const PLAYER_EXTENSION_ZIP = "webblackbox-chrome.zip";
export const PLAYER_EXTENSION_METADATA = "extension.json";

/**
 * The zip `pnpm --filter @webblackbox/extension zip` wrote for `version` (WXT's
 * `<name>-<version>-chrome.zip`), or null when this version was never packaged. A zip left over
 * from an older version is not used: the Player would offer testers an outdated extension. Other
 * builds (`-chrome-store-safe.zip`) do not match.
 */
export async function findPackagedExtensionZip(outputDir, version) {
  const suffix = `-${version}-chrome.zip`;
  const entries = await readdir(outputDir, { withFileTypes: true }).catch(() => []);
  const zips = entries.filter((entry) => entry.isFile() && entry.name.endsWith(suffix));

  if (zips.length > 1) {
    throw new Error(
      `More than one packaged extension for v${version} in ${outputDir}: ${zips.map((entry) => entry.name).join(", ")}`
    );
  }

  return zips[0] ? join(outputDir, zips[0].name) : null;
}

/**
 * Copies the packaged extension into the player build and writes the metadata next to it. With no
 * packaged zip the build stays valid: any stale copy in the output is removed and the result is
 * `{ bundled: false }` (the caller prints the warning).
 */
export async function bundleExtensionIntoPlayer({
  extensionPackageJson,
  extensionOutputDir,
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

  const zipPath = await findPackagedExtensionZip(extensionOutputDir, version);
  const targetDir = join(playerBuildDir, PLAYER_EXTENSION_DIR);

  if (!zipPath) {
    await rm(join(targetDir, PLAYER_EXTENSION_ZIP), { force: true });
    await rm(join(targetDir, PLAYER_EXTENSION_METADATA), { force: true });
    return { bundled: false, version };
  }

  const bytes = await readFile(zipPath);
  await mkdir(targetDir, { recursive: true });
  await writeFile(join(targetDir, PLAYER_EXTENSION_ZIP), bytes);

  const metadata = {
    version,
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
