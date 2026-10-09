// Off-camera setup for the videos after "install": a Chrome profile with the current build
// loaded unpacked, its icon pinned and the Player URL set. Built once per build (the same
// on-screen actions as the install video, just not recorded) and copied for every take.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

import { closeChrome } from "../lib/browser.mjs";
import { toWinPath } from "../lib/windows.mjs";
import { enableDeveloperMode, loadUnpacked, openExtensionsPage } from "./actions.mjs";
import {
  openOptionsFromPopup,
  openPopup,
  pinExtension,
  saveOptions,
  typePlayerUrl
} from "./configure.mjs";

const STAMP_FILE = "base-profile.json";

function buildStamp(ctx) {
  const manifest = join(ctx.config.extensionBuildDir, "manifest.json");
  if (!existsSync(manifest)) {
    throw new Error("no extension build: run `pnpm --filter @webblackbox/extension build` first");
  }
  return {
    version: ctx.config.extensionVersion,
    buildMtimeMs: Math.round(statSync(manifest).mtimeMs),
    playerUrl: ctx.config.playerUrl
  };
}

function paths(ctx) {
  return {
    baseWsl: join(ctx.config.workDirWsl, `base-profile-${ctx.lang}`),
    extensionWsl: join(ctx.config.workDirWsl, "extension", "webblackbox")
  };
}

/** Returns the WSL path of a ready profile, rebuilding it when the extension build changed. */
export async function ensureBaseProfile(ctx) {
  const { baseWsl, extensionWsl } = paths(ctx);
  const stamp = buildStamp(ctx);
  const stampFile = join(baseWsl, STAMP_FILE);
  if (existsSync(stampFile) && readFileSync(stampFile, "utf8") === JSON.stringify(stamp)) {
    return baseWsl;
  }
  ctx.log("building the base profile (off camera)");
  rmSync(extensionWsl, { recursive: true, force: true });
  mkdirSync(extensionWsl, { recursive: true });
  cpSync(ctx.config.extensionBuildDir, extensionWsl, { recursive: true });

  await ctx.startChrome({ url: "about:blank" });
  const page = await openExtensionsPage(ctx);
  await enableDeveloperMode(page);
  await loadUnpacked(ctx, page, toWinPath(extensionWsl));
  await page.waitFor({ css: "#name", text: "WebBlackbox" }, 15_000);
  await pinExtension(ctx);
  const popup = await openPopup(ctx);
  const options = await openOptionsFromPopup(ctx, popup);
  await typePlayerUrl(options, ctx.config.playerUrl);
  await saveOptions(options);
  await closeChrome(ctx.chrome);
  ctx.chrome = null;
  ctx.mainHwnd = null;

  rmSync(baseWsl, { recursive: true, force: true });
  cpSync(ctx.profileWsl, baseWsl, { recursive: true });
  writeFileSync(stampFile, JSON.stringify(stamp));
  return baseWsl;
}
