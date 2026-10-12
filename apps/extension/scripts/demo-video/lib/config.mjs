// Settings of the demo-video recorder. Windows paths are overridable through the environment;
// everything else is fixed so takes are reproducible.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { winToWslPath } from "./captions.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = resolve(HERE, "..", "..", "..");
const REPO_ROOT = resolve(EXTENSION_ROOT, "..", "..");
const EXTENSION_VERSION = JSON.parse(
  readFileSync(join(EXTENSION_ROOT, "package.json"), "utf8")
).version;

const workDirWin = process.env.WBB_DEMO_WIN_DIR ?? "C:\\Users\\Admin\\wbb-demo";
const reviewDirWin =
  process.env.WBB_DEMO_REVIEW_DIR ?? "C:\\Users\\Admin\\webblackbox-test-build\\videos";

export const DEMO_CONFIG = Object.freeze({
  extensionVersion: EXTENSION_VERSION,
  /** Unpacked build and packaged zip of the extension under test. */
  extensionBuildDir: join(EXTENSION_ROOT, "build"),
  extensionZip: join(EXTENSION_ROOT, "dist", `webblackbox-${EXTENSION_VERSION}-chrome.zip`),
  playerDir: join(REPO_ROOT, "apps", "player", "build"),
  /** Git-ignored: final videos, captions and caption marks. */
  outputDir: join(EXTENSION_ROOT, "demo-video-output"),
  workDirWin,
  workDirWsl: winToWslPath(workDirWin),
  reviewDirWin,
  reviewDirWsl: winToWslPath(reviewDirWin),
  /** The demo Chrome window: its visible frame is exactly the recorded rectangle. */
  window: Object.freeze({ x: 0, y: 0, width: 1600, height: 1000 }),
  cdpPort: 9333,
  demoPort: 4180,
  // Not 4177: testers (and the owner) often run their own Player there.
  playerPort: 4187,
  /** The Player the videos point testers at (typed into Options → Player URL). */
  playerUrl: process.env.WBB_DEMO_PLAYER_URL ?? "https://webblackbox.box.sg4m.org/",
  /** Visibly fake; shown in the videos. */
  passphrase: "demo-passphrase-2026",
  demoEmail: "qa@demo-shop.test",
  demoPassword: "demo-password",
  takeTimeoutMs: 6 * 60 * 1000
});
