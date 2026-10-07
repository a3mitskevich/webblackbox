// After loading the extension: pin its icon, open the popup, and set the Player URL in the
// options. Used by the install video (with captions) and by the off-camera profile setup.
import { UI } from "./actions.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PIN_NAME = /Закрепить|Pin/u;

/** Puzzle button -> the pin toggle next to WebBlackbox; closes the menu with a page click. */
export async function pinExtension(ctx) {
  await ctx.uiaClick({ controlType: "Button", name: UI.extensionsButton }, { afterMs: 900 });
  const menu = await ctx.waitWindow(
    (w) => w.hwnd !== ctx.mainHwnd && w.className === "Chrome_WidgetWin_1" && w.rect.height > 80,
    8000
  );
  const buttons = await ctx.agent.call(
    "uiaFind",
    { hwnd: menu.hwnd, controlType: "Button", all: true, visibleOnly: true, timeoutMs: 5000 },
    30_000
  );
  const pin = buttons.find((button) => PIN_NAME.test(button.name ?? ""));
  if (!pin?.center) {
    throw new Error(
      `pin button not found; menu buttons: ${buttons.map((b) => b.name).join(" | ")}`
    );
  }
  await ctx.agent.call("click", { x: pin.center.x, y: pin.center.y });
  await sleep(900);
  // Close the menu: a click on the empty page area below the toolbar.
  const frame = await ctx.agent.call("windowRect", { hwnd: ctx.mainHwnd });
  await ctx.agent.call("click", { x: frame.left + 200, y: frame.bottom - 120 });
  await sleep(500);
}

/** Clicks the pinned WebBlackbox toolbar icon and returns the popup page. */
export async function openPopup(ctx) {
  await ctx.dismissPopup();
  await ctx.uiaClick({ controlType: "Button", name: UI.extensionName, match: "startsWith" });
  const popup = await ctx.popup();
  await popup.waitFor({ css: "button" }, 10_000);
  await sleep(500);
  return popup;
}

export async function openOptionsFromPopup(ctx, popup) {
  await popup.click({ label: "Настройки" }, { afterMs: 300 });
  const options = await ctx.page((url) => url.includes("/options.html"));
  await options.waitFor({ css: 'a[data-section-link="export"]' }, 15_000);
  await sleep(600);
  return options;
}

/** Options -> "Export & encryption" -> types the Player URL (not saved yet). */
export async function typePlayerUrl(options, playerUrl) {
  await options.click({ css: 'a[data-section-link="export"]' }, { afterMs: 700 });
  await options.typeInto({ css: "#playerUrl" }, playerUrl, { charDelayMs: 60 });
  await sleep(400);
}

export async function saveOptions(options) {
  await options.click({ css: "#saveConfig" }, { afterMs: 1200 });
}

/** Captioned steps for the install video. */
export const CONFIGURE_STEPS = [
  {
    id: "pin",
    say: { ru: "Закрепите значок: «Расширения» → кнопка-булавка у WebBlackbox" },
    run: (ctx) => pinExtension(ctx)
  },
  {
    id: "popup",
    say: { ru: "Значок WebBlackbox открывает окно расширения" },
    async run(ctx) {
      ctx.state.popup = await openPopup(ctx);
      await sleep(800);
    }
  },
  {
    id: "options",
    say: { ru: "Кнопка «Настройки» открывает настройки во вкладке" },
    async run(ctx) {
      ctx.state.options = await openOptionsFromPopup(ctx, ctx.state.popup);
    }
  },
  {
    id: "player-url",
    say: { ru: "«Экспорт и шифрование» → «Адрес Player»: адрес плеера, который дала команда" },
    run: (ctx) => typePlayerUrl(ctx.state.options, ctx.config.playerUrl)
  },
  {
    id: "save",
    say: { ru: "Нажмите «Сохранить изменения» — всё готово, можно записывать" },
    run: (ctx) => saveOptions(ctx.state.options)
  }
];
