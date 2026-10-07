#!/usr/bin/env node
// Runs after `vite build`: ships the packaged Chrome extension inside the player build
// (build/extension/webblackbox-chrome.zip + extension.json). The extension is packaged by the
// workspace build (turbo makes the player build depend on the extension's `package:chrome`); when
// the zip is missing — a standalone `vite build`, a skipped packaging run — the build still
// succeeds, with this warning and without the metadata file, and the guide says so.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bundleExtensionIntoPlayer } from "./lib/bundle-extension.mjs";

const playerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const result = await bundleExtensionIntoPlayer({
  extensionPackageJson: resolve(playerRoot, "..", "extension", "package.json"),
  extensionDistDir: resolve(playerRoot, "..", "extension", "dist"),
  playerBuildDir: resolve(playerRoot, "build")
});

if (result.bundled) {
  const { metadata } = result;
  console.log(
    `Bundled the extension into the player build: extension/${metadata.file} ` +
      `(v${metadata.version}, ${metadata.size} bytes, sha256 ${metadata.sha256.slice(0, 12)}…)`
  );
} else {
  console.warn(
    `Warning: no packaged extension found for v${result.version} — this player build ships ` +
      "without extension/extension.json and the guide's download section stays empty.\n" +
      "Package it first: pnpm --filter @webblackbox/extension package:chrome"
  );
}
