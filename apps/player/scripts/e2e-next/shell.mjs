// Shell scenarios of e2e:player-next (R1 foundation + stage V): archive open and passphrase,
// stage / transport / timeline / rail, keyboard map, live language switch, theme, URL hash,
// responsive width, splitters, dialogs and tooltips. Feature scenarios live next to their
// feature (src/next/features/<feature>/<feature>.e2e.mjs).
import { sleep, waitFor } from "../lib/cdp-harness.mjs";
import {
  assert,
  dragBy,
  hover,
  navigate,
  navigateFresh,
  openEncrypted,
  openSyntheticArchive,
  press,
  readSnapshot,
  setFileInput,
  setViewport,
  testId,
  typePassphrase,
  waitForSelector,
  waitForSnapshot
} from "../lib/next-e2e.mjs";
import { SYNTHETIC_PASSPHRASE } from "../lib/synthetic-session.mjs";

const WRONG_PASSPHRASE = "definitely-wrong";

export async function verifyEmptyState(client, url) {
  await navigate(client, url);
  const snapshot = await client.evaluate(`(async () => {
    await document.fonts.ready;
    return {
      mains: document.querySelectorAll("main").length,
      // The classic stylesheet (its own chunk) defines --default-font-family on :root.
      classicStylesheet: getComputedStyle(document.documentElement).getPropertyValue("--default-font-family").trim() !== "",
      nextStylesheet: [...document.styleSheets].some((sheet) => (sheet.href ?? "").includes("/assets/") && sheet.href.endsWith(".css")),
      styleElements: document.querySelectorAll("style").length,
      empty: Boolean(document.querySelector('${testId("empty-state")}')),
      lang: document.documentElement.lang,
      title: document.querySelector('${testId("empty-state")} h1')?.textContent ?? "",
      font: getComputedStyle(document.body).fontFamily,
      onestLoaded: document.fonts.check('600 16px "Onest"')
    };
  })()`);
  assert(snapshot.mains === 1, "Expected exactly one <main>", snapshot);
  assert(
    !snapshot.classicStylesheet && snapshot.nextStylesheet,
    "Stylesheets not switched",
    snapshot
  );
  assert(snapshot.styleElements === 0, "The React player injected <style> elements", snapshot);
  assert(snapshot.empty && snapshot.title === "Open a recording", "Empty state missing", snapshot);
  assert(
    snapshot.font.includes("Onest") && snapshot.onestLoaded,
    "Onest is not self-hosted/loaded",
    snapshot
  );
  return snapshot;
}

export async function verifyEncryptedOpen(client, archivePath) {
  await setFileInput(client, archivePath);
  await waitForSelector(
    client,
    testId("passphrase-dialog"),
    15_000,
    "Passphrase dialog did not open"
  );
  // Base UI Dialog: a role="dialog" popup with a backdrop; the rest of the page is inert.
  const dialog = await client.evaluate(`(() => {
    const popup = document.querySelector('${testId("passphrase-dialog")}');
    const header = document.querySelector('${testId("header")}');
    return {
      role: popup.getAttribute("role"),
      ariaModal: popup.getAttribute("aria-modal"),
      backdrop: Boolean(document.querySelector(".dlg-backdrop")),
      outsideHidden: Boolean(header?.closest("[inert], [aria-hidden='true']")),
      labelled: Boolean(document.getElementById(popup.getAttribute("aria-labelledby") ?? "")),
      focused: document.activeElement?.dataset?.testid ?? ""
    };
  })()`);
  assert(
    dialog.role === "dialog" &&
      dialog.backdrop &&
      dialog.outsideHidden &&
      dialog.labelled &&
      dialog.focused === "passphrase-input",
    "Passphrase dialog is not a focused, labelled modal",
    dialog
  );

  await typePassphrase(client, WRONG_PASSPHRASE);
  await waitForSelector(
    client,
    testId("passphrase-invalid"),
    20_000,
    "Wrong passphrase was not reported"
  );
  await typePassphrase(client, SYNTHETIC_PASSPHRASE);
  await waitForSelector(
    client,
    testId("stage"),
    20_000,
    "Archive did not load after the passphrase"
  );
  return { dialog, invalidReported: true };
}

export async function verifyLoadedLayout(client) {
  const snapshot = await waitFor(
    async () => {
      const value = await readSnapshot(client);
      return value.media === "screenshot" || value.rows > 0 ? value : null;
    },
    15_000,
    150,
    "Loaded layout did not render"
  );
  assert(snapshot.session.includes("app.example.test"), "Session header missing", snapshot);
  assert(snapshot.encryption === "Encrypted", "Encryption chip missing", snapshot);
  assert(snapshot.otherTabs.includes("2"), "Other tabs chip missing", snapshot);
  assert(snapshot.clock === "0:00.00 / 0:17.80", "Unexpected clock after load", snapshot);
  assert(
    ["#/error", "#/lobby", "#/live/64"].every((label) =>
      snapshot.chapters.some((chapter) => chapter.includes(label))
    ),
    "Route chapters missing",
    snapshot
  );
  assert(snapshot.actionMarks === 6, "Expected six action marks", snapshot);
  assert(
    snapshot.errorTicks >= 1 && snapshot.networkBars >= 5 && snapshot.realtimeTicks >= 2,
    "Lanes are empty",
    snapshot
  );
  assert(
    snapshot.rows > 5 && snapshot.tab === "tab-activity",
    "Activity list did not render",
    snapshot
  );
  // The first tab is active: the tab strip starts unscrolled (Base UI scrolls the active tab
  // into view by its offsetLeft, which needs the strip to be the tabs' offsetParent).
  const tabsScroll = await client.evaluate(
    `document.querySelector('${testId("rail-tabs")}').scrollLeft`
  );
  assert(tabsScroll === 0, "The rail tab strip starts scrolled", { tabsScroll });
  return snapshot;
}

export async function verifyKeyboard(client) {
  await client.evaluate("document.activeElement?.blur()");
  await press(client, "e");
  // The virtual list renders the selected row only after it has scrolled to it (a frame later).
  const error = await waitForSnapshot(
    client,
    (value) =>
      value.live.startsWith("Error 1 of") &&
      value.selectedRow !== null &&
      value.clock !== "0:00.00 / 0:17.80",
    "E did not jump to, select and seek to the first error"
  );
  // The jump lands on the error: the selected row is the present, not the dimmed future.
  assert(error.selectedFuture === "false", "The selected error row is dimmed as future", error);

  await press(client, "l");
  const next = await waitForSnapshot(
    client,
    (value) => value.selectedRow !== null && value.selectedRow !== error.selectedRow,
    "L did not select the next event"
  );

  await press(client, "Enter", { code: "Enter", keyCode: 13 });
  const details = await waitForSnapshot(
    client,
    (value) => value.details.includes(`"${next.selectedRow}"`),
    "Enter did not open details"
  );
  await press(client, "Escape", { code: "Escape", keyCode: 27 });
  await waitForSnapshot(client, (value) => value.details === "", "Esc did not close details");

  await press(client, "?", { code: "Slash", shift: true });
  await waitForSnapshot(client, (value) => value.shortcuts, "? did not open the shortcut sheet");
  await press(client, "Escape", { code: "Escape", keyCode: 27 });
  await waitForSnapshot(
    client,
    (value) => !value.shortcuts,
    "Esc did not close the shortcut sheet"
  );

  await press(client, "2", { code: "Digit2" });
  await waitForSnapshot(
    client,
    (value) => value.tab === "tab-network",
    "2 did not open the Network tab"
  );
  await press(client, "1", { code: "Digit1" });
  await waitForSnapshot(
    client,
    (value) => value.tab === "tab-activity",
    "1 did not open the Activity tab"
  );

  await press(client, " ", { code: "Space", keyCode: 32 });
  await waitForSnapshot(
    client,
    (value) => value.playing === "true",
    "Space did not start playback"
  );
  await sleep(700);
  await press(client, " ", { code: "Space", keyCode: 32 });
  const paused = await waitForSnapshot(
    client,
    (value) => value.playing === "false",
    "Space did not pause"
  );
  assert(paused.clock !== next.clock, "Playback did not move the clock", { next, paused });

  await press(client, "Home", { code: "Home", keyCode: 36 });
  await waitForSnapshot(
    client,
    (value) => value.clock.startsWith("0:00.00"),
    "Home did not seek to the start"
  );
  await press(client, "ArrowRight", { code: "ArrowRight", keyCode: 39 });
  const stepped = await waitForSnapshot(
    client,
    (value) => value.clock.startsWith("0:01.00"),
    "→ did not step 1 s"
  );
  return { firstError: error.live, details: details.details.length, stepped: stepped.clock };
}

export async function verifyScrubbing(client) {
  const rect = await client.evaluate(`(() => {
    const box = document.querySelector('${testId("lane-network")}').getBoundingClientRect();
    return { x: box.left, y: box.top + box.height / 2, width: box.width };
  })()`);
  const x = rect.x + rect.width * 0.5;
  // Between bars: an empty spot of the realtime lane would pick an item, the ruler never does.
  const ruler = await client.evaluate(
    `(() => { const box = document.querySelector('.ruler').getBoundingClientRect(); return box.top + box.height / 2; })()`
  );
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y: ruler,
    button: "left",
    clickCount: 1
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: rect.x + rect.width * 0.75,
    y: ruler,
    button: "left"
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: rect.x + rect.width * 0.75,
    y: ruler,
    button: "left",
    clickCount: 1
  });
  const snapshot = await waitForSnapshot(
    client,
    (value) => value.clock.startsWith("0:13"),
    "Dragging the timeline did not seek"
  );
  return { clock: snapshot.clock };
}

export async function verifyLiveLocaleSwitch(client) {
  await press(client, "Home", { code: "Home", keyCode: 36 });
  await press(client, "e");
  const before = await waitForSnapshot(
    client,
    (value) => value.selectedRow !== null && value.live.startsWith("Error"),
    "No selection before the language switch"
  );
  await client.evaluate("window.__e2eMarker = 'kept'");

  await client.evaluate(`document.querySelector('${testId("locale-ru")}').click()`);
  const ru = await waitForSnapshot(
    client,
    (value) => value.lang === "ru" && value.tabText.startsWith("Хронология"),
    "Russian strings did not appear"
  );
  assert(ru.marker === "kept" && ru.unloads === 0, "Switching to Russian reloaded the page", ru);
  assert(ru.selectedRow === before.selectedRow, "Selection changed on language switch", {
    before,
    ru
  });
  assert(
    ru.clock === before.clock.replace(".", ",").replace(".", ","),
    "Playhead changed on language switch",
    { before, ru }
  );

  await client.evaluate(`document.querySelector('${testId("locale-zh-CN")}').click()`);
  const zh = await waitForSnapshot(
    client,
    (value) => value.lang === "zh-CN" && value.tabText.startsWith("活动"),
    "Chinese strings did not appear"
  );
  assert(
    zh.marker === "kept" && zh.unloads === 0 && zh.selectedRow === before.selectedRow,
    "Chinese switch lost state",
    zh
  );

  await client.evaluate(`document.querySelector('${testId("locale-en")}').click()`);
  const en = await waitForSnapshot(
    client,
    (value) => value.lang === "en" && value.tabText.startsWith("Activity"),
    "English strings did not come back"
  );
  assert(
    en.clock === before.clock && en.selectedRow === before.selectedRow,
    "State changed after EN→RU→中文→EN",
    { before, en }
  );
  const stored = await client.evaluate("localStorage.getItem('webblackbox.player.locale')");
  assert(stored === "en", "Locale was not stored", stored);
  return { ru: ru.tabText, zh: zh.tabText, clock: en.clock };
}

export async function verifyTheme(client) {
  const read = () =>
    client.evaluate(
      `({ theme: document.documentElement.dataset.theme, preference: document.documentElement.dataset.themePreference, background: getComputedStyle(document.body).backgroundColor })`
    );
  const system = await read();
  assert(
    system.preference === "system" && system.theme === "light",
    "Expected the system light theme",
    system
  );
  await client.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "dark" }]
  });
  const systemDark = await waitFor(
    async () => {
      const value = await read();
      return value.theme === "dark" ? value : null;
    },
    5_000,
    100,
    "System dark theme was not followed"
  );
  await client.evaluate(`document.querySelector('${testId("theme-toggle")}').click()`);
  const light = await waitFor(
    async () => {
      const value = await read();
      return value.preference === "light" && value.theme === "light" ? value : null;
    },
    5_000,
    100,
    "Theme toggle did not switch to light"
  );
  await client.evaluate(`document.querySelector('${testId("theme-toggle")}').click()`);
  const dark = await waitFor(
    async () => {
      const value = await read();
      return value.preference === "dark" && value.theme === "dark" ? value : null;
    },
    5_000,
    100,
    "Theme toggle did not switch to dark"
  );
  assert(light.background !== dark.background, "Theme did not change colours", { light, dark });
  await client.evaluate(`document.querySelector('${testId("theme-toggle")}').click()`);
  await client.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }]
  });
  return { systemDark: systemDark.background, light: light.background, dark: dark.background };
}

export async function verifyHashRestore(client, origin, archivePath) {
  // A URL that differs only in its hash would be a same-document navigation.
  await navigateFresh(client, `${origin}/?ui=next&lang=en#t=10.89&sel=req:90080.1706&tab=network`);
  await openEncrypted(client, archivePath, SYNTHETIC_PASSPHRASE);
  const restored = await waitForSnapshot(
    client,
    (value) => value.clock.startsWith("0:10.89"),
    "Hash time was not restored"
  );
  assert(restored.tab === "tab-network", "Hash tab was not restored", restored);
  await client.evaluate(`document.querySelector('${testId("tab-activity")}').click()`);
  // The hash is written after a debounce; wait for it instead of sleeping past it.
  const rewritten = await waitForSnapshot(
    client,
    (value) => value.hash.includes("tab=activity") && value.hash.includes("t=10.89"),
    "Hash was not rewritten"
  );
  // The selection only shows as a row on the Activity tab.
  assert(
    rewritten.selectedRow !== null && rewritten.hash.includes("sel=req%3A90080.1706"),
    "Hash selection was not restored",
    rewritten
  );
  return { clock: restored.clock, hash: rewritten.hash };
}

export async function verifyNarrowLayout(client) {
  await setViewport(client, 390, 844);
  await sleep(300);
  const narrow = await client.evaluate(`({
    scrollWidth: document.documentElement.scrollWidth,
    railBelowStage: document.querySelector('${testId("rail")}').getBoundingClientRect().top >
      document.querySelector('${testId("stage")}').getBoundingClientRect().bottom
  })`);
  await setViewport(client, 1440, 900);
  assert(
    narrow.scrollWidth <= 390 && narrow.railBelowStage,
    "Narrow layout scrolls horizontally or is not one column",
    narrow
  );
  return narrow;
}

/**
 * Physical keys (react-hotkeys-hook matches `event.code`): on a Russian layout KeyE types "у" and
 * KeyL types "д", yet E and L still jump; `?` (Shift+7 there) still opens the shortcut sheet.
 */
export async function verifyPhysicalKeys(client) {
  await press(client, "Home", { code: "Home", keyCode: 36 });
  await client.evaluate("document.activeElement?.blur()");
  await press(client, "у", { code: "KeyE" });
  const error = await waitForSnapshot(
    client,
    (value) => value.live.startsWith("Error 1 of") && value.selectedRow !== null,
    "Russian-layout E (KeyE → у) did not jump to the first error"
  );
  await press(client, "д", { code: "KeyL" });
  const next = await waitForSnapshot(
    client,
    (value) => value.selectedRow !== null && value.selectedRow !== error.selectedRow,
    "Russian-layout L (KeyL → д) did not select the next event"
  );
  await press(client, "?", { code: "Digit7", shift: true });
  await waitForSnapshot(
    client,
    (value) => value.shortcuts,
    "Russian-layout ? did not open the sheet"
  );
  await press(client, "Escape", { code: "Escape", keyCode: 27 });
  await waitForSnapshot(client, (value) => !value.shortcuts, "Esc did not close the sheet");
  return { error: error.selectedRow, next: next.selectedRow };
}

/**
 * Base UI parts: a tooltip on hover (no title attribute), the shortcut dialog opened from its
 * button returns focus there on Esc, and nothing injects a <style> element.
 */
export async function verifyDialogsAndHints(client) {
  await hover(client, testId("theme-toggle"));
  const hint = await waitFor(
    async () => {
      const value = await client.evaluate(`(() => {
        const tip = document.querySelector('${testId("tooltip")}');
        return tip ? { text: tip.textContent, visible: tip.getBoundingClientRect().height > 0 } : null;
      })()`);
      return value?.visible ? value : null;
    },
    5_000,
    100,
    "Hovering the theme toggle did not show its tooltip"
  );
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 600 });

  await client.evaluate(`document.querySelector('${testId("shortcuts-button")}').focus()`);
  await press(client, "Enter", { code: "Enter", keyCode: 13 });
  await waitForSnapshot(
    client,
    (value) => value.shortcuts,
    "Enter on the button did not open the sheet"
  );
  await press(client, "Escape", { code: "Escape", keyCode: 27 });
  await waitForSnapshot(client, (value) => !value.shortcuts, "Esc did not close the sheet");
  const after = await waitFor(
    async () => {
      const value = await client.evaluate(`({
        focused: document.activeElement?.dataset?.testid ?? "",
        styles: document.querySelectorAll("style").length,
        titles: document.querySelectorAll('${testId("header")} button[title]').length
      })`);
      return value.focused === "shortcuts-button" ? value : null;
    },
    5_000,
    100,
    "Focus did not return to the shortcuts button"
  );
  assert(after.styles === 0, "A component injected a <style> element", after);
  assert(after.titles === 0, "Header buttons still carry native title tooltips", after);
  return { hint: hint.text, ...after };
}

/**
 * Stage ↔ rail splitter: dragging and the keyboard resize the rail, the size survives a reload
 * (localStorage), and "Reset layout" brings back the default width.
 */
export async function verifySplitters(client, { origin, archivePath }) {
  const storageKey = "react-resizable-panels:webblackbox.player.layout.body";
  const railWidth = () =>
    client.evaluate(`document.querySelector('${testId("rail")}').getBoundingClientRect().width`);
  await setViewport(client, 1440, 900);
  await client.evaluate(`localStorage.removeItem(${JSON.stringify(storageKey)})`);
  await openSyntheticArchive(client, { origin, archivePath });

  const initial = await railWidth();
  assert(Math.abs(initial - 520) <= 4, "The rail does not start at 520 px on 1440", { initial });

  await dragBy(client, testId("split-body"), -120, 0);
  const dragged = await waitFor(
    async () => {
      const width = await railWidth();
      return width > initial + 100 ? width : null;
    },
    5_000,
    100,
    "Dragging the splitter did not widen the rail"
  );

  const clock = (await readSnapshot(client)).clock;
  await client.evaluate(`document.querySelector('${testId("split-body")}').focus()`);
  await press(client, "ArrowRight", { code: "ArrowRight", keyCode: 39 });
  const keyed = await waitFor(
    async () => {
      const width = await railWidth();
      return width < dragged - 1 ? width : null;
    },
    5_000,
    100,
    "→ on the focused splitter did not resize the rail"
  );
  assert((await readSnapshot(client)).clock === clock, "→ on the splitter also seeked", { clock });

  const stored = await waitFor(
    async () => client.evaluate(`localStorage.getItem(${JSON.stringify(storageKey)})`),
    5_000,
    100,
    "The splitter size was not stored"
  );

  await openSyntheticArchive(client, { origin, archivePath });
  const restored = await railWidth();
  assert(Math.abs(restored - keyed) <= 4, "The rail width was not restored after a reload", {
    keyed,
    restored
  });

  await client.evaluate(`document.querySelector('${testId("reset-layout")}').click()`);
  const reset = await waitFor(
    async () => {
      const width = await railWidth();
      return Math.abs(width - initial) <= 4 ? width : null;
    },
    5_000,
    100,
    "Reset layout did not restore the default rail width"
  );
  const cleared = await client.evaluate(`localStorage.getItem(${JSON.stringify(storageKey)})`);
  assert(cleared === null, "Reset layout kept the stored size", { cleared });
  return { initial, dragged, keyed, restored, reset, stored: JSON.parse(stored) };
}
