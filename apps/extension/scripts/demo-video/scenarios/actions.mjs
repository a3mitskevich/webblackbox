// Reusable on-screen actions shared by the scenarios (and by the off-camera profile setup).
// Names of native Chrome/Windows UI are the Russian ones: the videos are recorded in Russian on a
// Russian Windows (owner decision).
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const EXPLORER_CLASS = "CabinetWClass";
const WINUI_POPUP_CLASS = "Microsoft.UI.Content.PopupWindowSiteBridge";

export const UI = Object.freeze({
  extensionsButton: "Расширения",
  extractAll: "Извлечь все...",
  extractDialogTitle: /^Извлечение|ZIP/u,
  extractButton: "Извлечь",
  close: "Закрыть",
  folderDialogTitle: "Выберите каталог расширения",
  folderField: "Папка:",
  selectFolder: "Выбор папки",
  fileNameField: "Имя файла:",
  extensionName: "WebBlackbox"
});

/** Takes over an Explorer window something else opened (e.g. Chrome's "Show in folder"). */
export async function adoptExplorer(ctx, titlePrefix, bounds) {
  const win = await ctx
    .waitWindow(
      (w) => w.className === EXPLORER_CLASS && w.title.startsWith(titlePrefix),
      30_000,
      []
    )
    .catch(async (error) => {
      const titles = (await ctx.agent.call("windows", {}))
        .filter((w) => w.className === EXPLORER_CLASS)
        .map((w) => w.title);
      throw new Error(
        `${error.message}: no "${titlePrefix}" Explorer (open: ${titles.join(" | ")})`
      );
    });
  await ctx.agent.call("placeWindow", { hwnd: win.hwnd, ...bounds });
  await ctx.agent.call("foreground", { hwnd: win.hwnd });
  await ctx.guard([win.pid]);
  await sleep(700);
  return win;
}

/** Closes every Explorer window whose title starts with one of `titles` (cleanup only). */
export async function closeExplorerWindows(ctx, titles) {
  const matching = async () =>
    (await ctx.agent.call("windows", {})).filter(
      (w) => w.className === EXPLORER_CLASS && titles.some((title) => w.title.startsWith(title))
    );
  for (const w of await matching()) await ctx.agent.call("closeWindow", { hwnd: w.hwnd });
  // Explorer reuses an open window for the same folder: wait until the old ones are really gone.
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if ((await matching()).length === 0) return;
    await sleep(200);
  }
  throw new Error(`Explorer windows did not close: ${titles.join(", ")}`);
}

/** Right-click the zip -> "Extract all..."; returns the extraction dialog. */
export async function openExtractDialog(ctx, explorer, zipBaseName) {
  const item = await ctx.uiaFind(
    { controlType: "ListItem", name: zipBaseName, match: "startsWith" },
    explorer.hwnd
  );
  await ctx.agent.call("click", { x: item.center.x, y: item.center.y });
  await sleep(500);
  await ctx.agent.call("click", { x: item.center.x, y: item.center.y, button: "right" });
  const menu = await ctx
    .waitWindow((w) => w.className === WINUI_POPUP_CLASS && w.rect.height > 200, 8000, [])
    .catch(async (error) => {
      const fg = await ctx.agent.call("foregroundInfo");
      throw new Error(
        `${error.message}: no context menu (foreground: ${fg.className} "${fg.title}")`
      );
    });
  await ctx.guard([explorer.pid, menu.pid]);
  await sleep(700);
  await ctx.uiaClick({ controlType: "MenuItem", name: UI.extractAll }, { hwnd: menu.hwnd });
  const dialog = await ctx.waitWindow((w) => UI.extractDialogTitle.test(w.title), 15_000, []);
  await ctx.guard([explorer.pid, dialog.pid]);
  // Windows opens it wherever it likes (once half outside the recorded frame): centre it on
  // the Explorer window.
  const frame = await ctx.agent.call("windowRect", { hwnd: explorer.hwnd });
  const size = dialog.rect;
  await ctx.agent.call("placeWindow", {
    hwnd: dialog.hwnd,
    x: Math.round(frame.left + (frame.width - size.width) / 2),
    y: Math.round(frame.top + (frame.height - size.height) / 2),
    width: size.width,
    height: size.height
  });
  await sleep(400);
  return dialog;
}

/** Clicks "Extract" in the extraction dialog. */
export async function confirmExtract(ctx, dialog) {
  await ctx.uiaClick({ controlType: "Button", name: UI.extractButton }, { hwnd: dialog.hwnd });
}

/** chrome://extensions page with the real cursor: Developer mode on, "Load unpacked". */
export async function openExtensionsPage(ctx) {
  await ctx.navigate("chrome://extensions");
  const page = await ctx.page("chrome://extensions");
  await page.waitFor({ css: "#devMode" }, 15_000);
  return page;
}

export async function enableDeveloperMode(page) {
  const checked = await page.withElement({ css: "#devMode" }, "(el) => el.checked === true");
  if (!checked) await page.click({ css: "#devMode" }, { afterMs: 900 });
}

/** "Load unpacked" -> the native folder picker -> type the folder -> "Select folder". */
export async function loadUnpacked(ctx, page, folderWin) {
  await page.click({ css: "#loadUnpacked" }, { afterMs: 300 });
  // Chrome shows Windows file dialogs from a separate utility process: search every window.
  const dialog = await ctx.waitWindow(
    (w) => w.className === "#32770" && w.title === UI.folderDialogTitle,
    15_000,
    []
  );
  await ctx.guard([dialog.pid]);
  await sleep(900);
  const field = await ctx.uiaFind({ controlType: "Edit", name: UI.folderField }, dialog.hwnd);
  await ctx.agent.call("click", { x: field.center.x, y: field.center.y });
  await ctx.agent.call("keys", { combo: "ctrl+a" });
  await ctx.agent.call("type", { text: folderWin, charDelayMs: 35 }, 60_000);
  await sleep(500);
  // With a typed path the first "Select folder" may only navigate into the folder; a second
  // click then selects it (what a person does when the dialog stays open).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await ctx.uiaClick({ controlType: "Button", name: UI.selectFolder }, { hwnd: dialog.hwnd });
    await sleep(1200);
    const stillOpen = (await ctx.agent.call("windows", {})).some((w) => w.hwnd === dialog.hwnd);
    if (!stillOpen) break;
  }
  await ctx.guard([]);
  await sleep(800);
}

/**
 * Picks a file in the Windows "Open" dialog a page's file input opened: types the full path into
 * "File name" and presses Enter. `knownHwnds` are the dialogs that existed before the click.
 */
export async function chooseFileInOpenDialog(ctx, fileWin, knownHwnds) {
  const dialog = await ctx.waitWindow(
    (w) => w.className === "#32770" && !knownHwnds.has(w.hwnd),
    15_000,
    []
  );
  await ctx.guard([dialog.pid]);
  await sleep(900);
  const field = await ctx.uiaFind({ controlType: "Edit", name: UI.fileNameField }, dialog.hwnd);
  await ctx.agent.call("click", { x: field.center.x, y: field.center.y });
  await ctx.agent.call("type", { text: fileWin, charDelayMs: 30 }, 60_000);
  await sleep(500);
  await ctx.agent.call("keys", { combo: "enter" });
  await sleep(1200);
  await ctx.guard([]);
}

/** The dialogs open right now, so the next one can be told apart. */
export async function currentDialogs(ctx) {
  const windows = await ctx.agent.call("windows", {});
  return new Set(windows.filter((w) => w.className === "#32770").map((w) => w.hwnd));
}
