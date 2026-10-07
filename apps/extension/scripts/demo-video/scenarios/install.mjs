// Video 1 — install: unzip the test build in Explorer, load it unpacked in chrome://extensions,
// pin the icon, set the Player URL in the options.
import { join } from "node:path";

import {
  adoptExplorer,
  closeExplorerWindows,
  confirmExtract,
  enableDeveloperMode,
  loadUnpacked,
  openExtensionsPage,
  openExtractDialog,
  UI
} from "./actions.mjs";
import { CONFIGURE_STEPS } from "./configure.mjs";
import { toWinPath } from "../lib/windows.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const EXPLORER_BOUNDS = Object.freeze({ x: 150, y: 110, width: 1300, height: 780 });

// The guide in the Player serves the zip under a fixed name (task 50).
const GUIDE_ZIP_BASE = "webblackbox-chrome";
const GUIDE_LINK = "Ещё нет расширения? Скачайте его и посмотрите, как установить.";

export function testerPaths(ctx) {
  return {
    zipBase: GUIDE_ZIP_BASE,
    downloadsTitle: ctx.downloadsWsl.split("/").at(-1),
    extractedWsl: join(ctx.downloadsWsl, GUIDE_ZIP_BASE)
  };
}

/** @type {import("./index.mjs").Scenario} */
export const installScenario = {
  id: "install",
  title: { ru: "Установка WebBlackbox" },

  async prepare(ctx) {
    const { zipBase, downloadsTitle } = testerPaths(ctx);
    await closeExplorerWindows(ctx, [downloadsTitle, zipBase]);
    await ctx.startChrome({ url: ctx.config.playerUrl });
    ctx.state.player = await ctx.page(ctx.config.playerUrl);
    await ctx.state.player.waitFor({ text: GUIDE_LINK }, 20_000);
  },

  steps: [
    {
      id: "intro",
      say: { ru: "Установка WebBlackbox в Chrome — пара минут" },
      run: (ctx) => ctx.pause(800)
    },
    {
      id: "guide",
      say: { ru: "Откройте Player команды → «Ещё нет расширения? Скачайте его…»" },
      run: (ctx) => ctx.state.player.click({ text: GUIDE_LINK }, { afterMs: 1200 })
    },
    {
      id: "download",
      say: { ru: "«Скачать расширение (.zip)» — сборка лежит прямо в Player" },
      async run(ctx) {
        await ctx.state.player.click(
          { css: '[data-testid="extension-download-link"]' },
          { afterMs: 2500 }
        );
      }
    },
    {
      id: "show-in-folder",
      say: { ru: "Откройте папку со скачанным архивом" },
      async run(ctx) {
        const { downloadsTitle } = testerPaths(ctx);
        const item = await ctx.uiaFind({
          controlType: "Button",
          name: `${GUIDE_ZIP_BASE}.zip`,
          match: "startsWith"
        });
        await ctx.agent.call("moveTo", { x: item.center.x, y: item.center.y });
        await sleep(700);
        await ctx.uiaClick({ controlType: "Button", name: "Показать файл", match: "startsWith" });
        ctx.state.explorer = await adoptExplorer(ctx, downloadsTitle, EXPLORER_BOUNDS);
      }
    },
    {
      id: "unzip",
      say: { ru: "Правый клик по архиву → «Извлечь все…»" },
      async run(ctx) {
        const { zipBase } = testerPaths(ctx);
        ctx.state.extractDialog = await openExtractDialog(ctx, ctx.state.explorer, zipBase);
      }
    },
    {
      id: "extract",
      say: { ru: "Нажмите «Извлечь» — откроется папка с расширением" },
      run: (ctx) => confirmExtract(ctx, ctx.state.extractDialog)
    },
    {
      id: "folder",
      say: { ru: "В папке лежит manifest.json — именно её выберем в Chrome" },
      async run(ctx) {
        const { zipBase } = testerPaths(ctx);
        const folder = await ctx.waitWindow(
          (w) => w.className === "CabinetWClass" && w.title.startsWith(zipBase),
          20_000,
          []
        );
        await ctx.agent.call("placeWindow", { hwnd: folder.hwnd, ...EXPLORER_BOUNDS });
        await ctx.agent.call("foreground", { hwnd: folder.hwnd });
        await ctx.guard([folder.pid, ctx.state.explorer.pid]);
        await sleep(600);
        const manifest = await ctx.uiaFind(
          { controlType: "ListItem", name: "manifest", match: "startsWith" },
          folder.hwnd
        );
        await ctx.agent.call("click", { x: manifest.center.x, y: manifest.center.y });
        await sleep(1500);
        ctx.state.folder = folder;
      }
    },
    {
      id: "close-explorer",
      async run(ctx) {
        for (const win of [ctx.state.folder, ctx.state.explorer]) {
          await ctx.uiaClick({ controlType: "Button", name: UI.close }, { hwnd: win.hwnd });
        }
        await ctx.guard([]);
        await ctx.focusMain();
      }
    },
    {
      id: "extensions-page",
      say: { ru: "В Chrome откройте страницу chrome://extensions" },
      async run(ctx) {
        ctx.state.extensionsPage = await openExtensionsPage(ctx);
        await sleep(500);
      }
    },
    {
      id: "dev-mode",
      say: { ru: "Включите «Режим разработчика» справа вверху" },
      run: (ctx) => enableDeveloperMode(ctx.state.extensionsPage)
    },
    {
      id: "load-unpacked",
      say: { ru: "«Загрузить распакованное расширение» → выберите распакованную папку" },
      async run(ctx) {
        const { extractedWsl } = testerPaths(ctx);
        await loadUnpacked(ctx, ctx.state.extensionsPage, toWinPath(extractedWsl));
      }
    },
    {
      id: "installed",
      say: { ru: "Расширение установлено — его карточка появилась в списке" },
      async run(ctx) {
        await ctx.state.extensionsPage.waitFor({ css: "#name", text: "WebBlackbox" }, 15_000);
        await ctx.state.extensionsPage.hover({ css: "#card" }, 1200);
      }
    },
    ...CONFIGURE_STEPS
  ],

  async cleanup(ctx) {
    const { zipBase, downloadsTitle } = testerPaths(ctx);
    await closeExplorerWindows(ctx, [downloadsTitle, zipBase]);
  }
};
