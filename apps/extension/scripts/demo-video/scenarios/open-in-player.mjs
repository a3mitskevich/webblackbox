// Video 3 — open in the Player: pick the exported archive and enter the passphrase. What is
// inside the Player is out of scope for the videos (owner decision).
import { copyFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

import { toWinPath } from "../lib/windows.mjs";
import { chooseFileInOpenDialog, currentDialogs } from "./actions.mjs";
import { ensureBaseProfile } from "./profiles.mjs";
import { fixtureArchiveWsl } from "./record-and-export.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const testId = (id) => ({ css: `[data-testid="${id}"]` });

/** Starts Chrome on the Player with the fixture archive in Downloads/webblackbox. */
export async function preparePlayerTake(ctx) {
  const fixture = fixtureArchiveWsl(ctx);
  if (!fixture) throw new Error("no fixture archive: record the record-and-export video first");
  const base = await ensureBaseProfile(ctx);
  await ctx.startChrome({ fromProfileWsl: base, url: ctx.config.playerUrl });
  const exportsWsl = join(ctx.downloadsWsl, "webblackbox");
  mkdirSync(exportsWsl, { recursive: true });
  ctx.state.archiveWin = toWinPath(join(exportsWsl, basename(fixture)));
  copyFileSync(fixture, join(exportsWsl, basename(fixture)));
  ctx.state.player = await ctx.page(ctx.config.playerUrl);
  await ctx.state.player.waitFor({ text: "Выбрать архив…" }, 20_000);
  // Off camera, pick the file once: Windows remembers the folder, so on camera the Open dialog
  // starts in Downloads\webblackbox instead of the user's home folder.
  await openArchive(ctx);
  await ctx.state.player.click({ css: '[role="dialog"] button', text: "Отмена" }, { afterMs: 500 });
  await ctx.state.player.session.send("Page.reload");
  await ctx.state.player.waitFor({ text: "Выбрать архив…" }, 20_000);
  await ctx.focusMain();
}

/** "Choose archive…" -> the Windows Open dialog -> passphrase -> "Open". */
export async function openArchive(ctx) {
  const player = ctx.state.player;
  const known = await currentDialogs(ctx);
  await player.click({ text: "Выбрать архив…" }, { afterMs: 300 });
  await chooseFileInOpenDialog(ctx, ctx.state.archiveWin, known);
  await player.waitFor(testId("passphrase-input"), 15_000);
}

export async function enterPassphrase(ctx) {
  const player = ctx.state.player;
  await player.typeInto(testId("passphrase-input"), ctx.config.passphrase, { charDelayMs: 70 });
  await sleep(400);
  await player.click(testId("passphrase-submit"), { afterMs: 300 });
  await player.waitFor(testId("tab-network"), 30_000);
  await sleep(1200);
}

/** @type {import("./index.mjs").Scenario} */
export const openInPlayerScenario = {
  id: "open-in-player",
  title: { ru: "Запись в Player" },
  prepare: preparePlayerTake,

  steps: [
    {
      id: "intro",
      say: { ru: "Открываем запись в Player: нужен файл архива и пароль к нему" },
      run: (ctx) => ctx.pause(600)
    },
    {
      id: "choose",
      say: { ru: "«Выбрать архив…» → файл из «Загрузки\\webblackbox» (или перетащите его в окно)" },
      run: (ctx) => openArchive(ctx)
    },
    {
      id: "passphrase",
      say: { ru: "Введите пароль, с которым архив экспортировали" },
      run: (ctx) => enterPassphrase(ctx)
    },
    {
      id: "opened",
      say: {
        ru: "Запись открыта: проблемы, хронология, сеть, консоль и видео вкладки — всё здесь"
      },
      async run(ctx) {
        await ctx.state.player.hover(testId("problem-chip"), 1800);
        await ctx.state.player.hover(testId("event-row"), 1500);
      }
    }
  ]
};
