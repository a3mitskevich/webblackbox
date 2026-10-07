// Video 2 — record and export: pick a profile, start with the reload offer, reproduce a bug on
// the demo shop (login, order list, a failing report), stop, export with a passphrase. The
// exported archive is kept as the fixture for the Player videos.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { openPopup } from "./configure.mjs";
import { ensureBaseProfile } from "./profiles.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RECORD_PROFILE = "Full capture";
const EXPORT_WAIT_MS = 60_000;

/** The archive the last record-and-export take exported (kept under its real file name). */
export function fixtureArchiveWsl(ctx) {
  return newestArchive(join(ctx.config.workDirWsl, "fixtures"));
}

/** Opens the native <select> and walks to `label` with the arrow keys, like a person would. */
async function chooseProfile(ctx, popup, label) {
  const plan = await popup.withElement(
    { css: "#wb-profile-select" },
    `(el) => ({
      from: el.selectedIndex,
      to: [...el.options].findIndex((o) => o.text.trim().startsWith(${JSON.stringify(label)})),
      options: [...el.options].map((o) => o.text.trim())
    })`
  );
  if (!plan || plan.to < 0) {
    throw new Error(`profile "${label}" is not in the picker: ${plan?.options?.join(" | ")}`);
  }
  await popup.click({ css: "#wb-profile-select" }, { afterMs: 700 });
  const key = plan.to > plan.from ? "down" : "up";
  for (let i = 0; i < Math.abs(plan.to - plan.from); i += 1) {
    await ctx.agent.call("keys", { combo: key });
    await sleep(320);
  }
  await sleep(400);
  await ctx.agent.call("keys", { combo: "enter" });
  await sleep(900);
}

function newestArchive(dirWsl) {
  if (!existsSync(dirWsl)) return null;
  const files = readdirSync(dirWsl, { recursive: true })
    .map(String)
    // Chrome on Windows saves the export as <sid>.zip (it picks the extension from the zip MIME
    // type); the Player opens both.
    .filter((name) => /\.(webblackbox|zip)$/u.test(name))
    .map((name) => join(dirWsl, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0] ?? null;
}

/** @type {import("./index.mjs").Scenario} */
export const recordAndExportScenario = {
  id: "record-and-export",
  title: { ru: "Запись и экспорт" },

  async prepare(ctx) {
    const base = await ensureBaseProfile(ctx);
    await ctx.startChrome({ fromProfileWsl: base, url: ctx.servers.demoUrl });
    ctx.state.site = await ctx.page(ctx.servers.demoUrl);
    await ctx.state.site.waitFor({ css: "#login-button" });
  },

  steps: [
    {
      id: "intro",
      say: { ru: "Как записать баг: профиль → запись → повторить баг → стоп → экспорт" },
      run: (ctx) => ctx.pause(600)
    },
    {
      id: "popup",
      say: { ru: "Откройте страницу с багом и нажмите значок WebBlackbox" },
      async run(ctx) {
        ctx.state.popup = await openPopup(ctx);
        await ctx.state.popup.hover({ css: "#wb-profile-select" }, 900);
      }
    },
    {
      id: "default-profile",
      say: { ru: "Профиль Default пишет только метаданные: без текстов, тел запросов и значений" },
      run: (ctx) => ctx.pause(1200)
    },
    {
      id: "full-capture",
      say: {
        ru: "Для бага выберите QA или Full capture. Full capture пишет всё — только тестовые аккаунты!"
      },
      run: (ctx) => chooseProfile(ctx, ctx.state.popup, RECORD_PROFILE)
    },
    {
      id: "visual",
      say: { ru: "«Визуал → Оба»: скриншоты и видео вкладки" },
      async run(ctx) {
        const popup = ctx.state.popup;
        const hasVisual = await popup.withElement({ text: "Оба" }, "() => true");
        if (hasVisual) await popup.click({ text: "Оба" }, { afterMs: 700 });
        else await sleep(800);
      }
    },
    {
      id: "start",
      say: {
        ru: "«Начать запись» → «Перезагрузить и начать»: загрузка страницы тоже попадёт в запись"
      },
      async run(ctx) {
        const popup = ctx.state.popup;
        await popup.click({ css: 'button[data-action="start"]' }, { afterMs: 900 });
        await popup.click({ text: "Перезагрузить и начать" }, { afterMs: 2500 });
      }
    },
    {
      id: "debug-bar",
      say: {
        ru: "Плашка «WebBlackbox отлаживает браузер» — так работает полный режим, это нормально"
      },
      async run(ctx) {
        await ctx.state.site.waitFor({ css: "#login-button" }, 20_000);
        await sleep(1500);
      }
    },
    {
      id: "login",
      say: { ru: "Повторяем шаги бага: входим под тестовым аккаунтом" },
      async run(ctx) {
        const site = ctx.state.site;
        await site.typeInto({ css: "#email" }, ctx.config.demoEmail, { charDelayMs: 60 });
        await site.typeInto({ css: "#password" }, ctx.config.demoPassword, { charDelayMs: 60 });
        await site.click({ css: "#login-button" }, { afterMs: 1500 });
      }
    },
    {
      id: "orders",
      say: { ru: "Список заказов пришёл запросом к API, уведомления — по WebSocket" },
      async run(ctx) {
        const site = ctx.state.site;
        await site.waitFor({ css: "#orders tr" }, 15_000);
        await site.hover({ css: "#orders tr", index: 2 }, 1200);
        await site.click({ css: "#reload-orders" }, { afterMs: 1200 });
      }
    },
    {
      id: "report",
      say: { ru: "«Построить отчёт» — запрос падает с ошибкой 500, в консоли ошибка" },
      async run(ctx) {
        await ctx.state.site.click({ css: "#load-report" }, { afterMs: 1800 });
      }
    },
    {
      // Not Ctrl+Shift+M: in Chrome 154 that shortcut opens Chrome's own profile menu.
      id: "marker",
      say: { ru: "Значок WebBlackbox → «Маркер» отмечает важный момент записи" },
      async run(ctx) {
        ctx.state.popup = await openPopup(ctx);
        await ctx.state.popup.click({ text: "Маркер" }, { afterMs: 1200 });
      }
    },
    {
      id: "stop",
      say: { ru: "Баг повторён — нажмите «Остановить»" },
      async run(ctx) {
        await ctx.state.popup.click({ css: 'button[data-action="stop"]' }, { afterMs: 1500 });
      }
    },
    {
      id: "export",
      say: {
        ru: "«Экспорт» → пароль не короче 8 символов. Без пароля экспорта нет: архив шифруется"
      },
      async run(ctx) {
        const popup = ctx.state.popup;
        await popup.click({ css: 'button[data-action="export"]' }, { afterMs: 900 });
        await popup.typeInto({ css: "#wb-passphrase-input" }, ctx.config.passphrase, {
          charDelayMs: 70
        });
        await sleep(500);
        await ctx.agent.call("keys", { combo: "enter" });
      }
    },
    {
      id: "downloaded",
      say: { ru: "Архив записи скачан в «Загрузки». Пароль передавайте отдельно от файла" },
      async run(ctx) {
        const started = Date.now();
        let archive = null;
        while (!archive && Date.now() - started < EXPORT_WAIT_MS) {
          await sleep(500);
          archive = newestArchive(ctx.downloadsWsl);
        }
        if (!archive) throw new Error("the export did not produce an archive file");
        await sleep(2500);
        const fixturesWsl = join(ctx.config.workDirWsl, "fixtures");
        rmSync(fixturesWsl, { recursive: true, force: true });
        mkdirSync(fixturesWsl, { recursive: true });
        copyFileSync(archive, join(fixturesWsl, basename(archive)));
      }
    }
  ]
};
