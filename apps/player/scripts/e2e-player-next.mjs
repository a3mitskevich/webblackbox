#!/usr/bin/env node
// E2E for the React player (`?ui=next`, stage R1): encrypted archive open + passphrase flow,
// stage/transport/timeline/rail, keyboard map, live language switch without reload, theme, URL
// hash, responsive width and CSP. Selectors are `data-testid` only.
//
// Env: WB_E2E_CHROME_BIN, WB_E2E_HEADLESS (default 1), WB_E2E_PLAYER_DIR (default ./build),
// WB_E2E_SCREENSHOTS_DIR (capture classic vs next at 1440/1920, light/dark, EN/RU),
// WB_E2E_REAL_ARCHIVE + WB_E2E_REAL_PASSPHRASE (also open a real archive; screenshots stay local).
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CdpClient,
  CHROME_CANDIDATES,
  closeTarget,
  launchChromeWithRetry,
  openTarget,
  resolveChromeBinary,
  sleep,
  startPlayerServer,
  terminateChromeProcess,
  waitFor
} from "./lib/cdp-harness.mjs";
import { createEncryptedArchive } from "./lib/encrypted-archive.mjs";
import { SYNTHETIC_PASSPHRASE } from "./lib/synthetic-session.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const playerDir = process.env.WB_E2E_PLAYER_DIR ?? resolve(root, "..", "build");
const headless = (process.env.WB_E2E_HEADLESS ?? "1") !== "0";
const stamp = Date.now();
const artifactsDir = process.env.WB_E2E_ARTIFACTS_DIR ?? `/tmp/webblackbox-player-next-${stamp}`;
const screenshotsDir = process.env.WB_E2E_SCREENSHOTS_DIR ?? null;
const realArchive = process.env.WB_E2E_REAL_ARCHIVE ?? null;
const realPassphrase = process.env.WB_E2E_REAL_PASSPHRASE ?? "";
const WRONG_PASSPHRASE = "definitely-wrong";

const state = { chrome: null, client: null, targetId: null, baseUrl: null, server: null };
const testId = (id) => `[data-testid="${id}"]`;

main().catch(async (error) => {
  console.error("Player next E2E failed:", error instanceof Error ? error.message : String(error));
  await cleanup();
  process.exit(1);
});

async function main() {
  await access(resolve(playerDir, "main.js"), constants.R_OK);
  const build = await verifyBuildOutput(playerDir);
  await mkdir(artifactsDir, { recursive: true });

  const archivePath = resolve(artifactsDir, "synthetic-replay.webblackbox");
  await writeFile(archivePath, await createEncryptedArchive());

  const server = await startPlayerServer(playerDir);
  state.server = server.server;
  const origin = `http://127.0.0.1:${server.port}`;
  const chrome = await launchChromeWithRetry(await resolveChromeBinary(CHROME_CANDIDATES), {
    profileDir: `/tmp/webblackbox-player-next-profile-${stamp}`,
    requestedRemotePort: null,
    headless,
    logPath: `/tmp/webblackbox-player-next-${stamp}.log`,
    attempts: 2,
    readyTimeoutMs: 25_000
  });
  state.chrome = chrome;
  state.baseUrl = chrome.baseUrl;

  const target = await openTarget(chrome.baseUrl, "about:blank");
  state.targetId = target.id;
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  state.client = client;

  const exceptions = [];
  client.on("Runtime.exceptionThrown", (params) => {
    exceptions.push(
      params?.exceptionDetails?.exception?.description ?? params?.exceptionDetails?.text
    );
  });
  // Violations reach Node through a binding, so pages replaced by later navigations count too.
  const cspViolations = [];
  client.on("Runtime.bindingCalled", (params) => {
    if (params?.name === "__wbCspViolation") {
      cspViolations.push(JSON.parse(params.payload));
    }
  });
  await client.send("Runtime.enable");
  await client.send("Runtime.addBinding", { name: "__wbCspViolation" });
  await client.send("DOM.enable");
  await client.send("Page.enable");
  await client.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `document.addEventListener("securitypolicyviolation", (e) => window.__wbCspViolation(JSON.stringify({ page: location.href, violation: [e.violatedDirective, e.blockedURI, e.sourceFile + ":" + e.lineNumber + ":" + e.columnNumber, e.sample].join(" ") })));
             window.__unloads = 0; window.addEventListener("beforeunload", () => { window.__unloads += 1; });`
  });
  await setViewport(client, 1440, 900);
  await client.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }]
  });

  const results = { build };
  results.empty = await verifyEmptyState(client, `${origin}/?ui=next&lang=en`);
  assert(
    await client.evaluate("typeof window.__wbCspViolation === 'function'"),
    "CSP violation binding is missing; the CSP check would pass vacuously"
  );
  results.open = await verifyEncryptedOpen(client, archivePath);
  results.layout = await verifyLoadedLayout(client);
  results.keyboard = await verifyKeyboard(client);
  results.scrub = await verifyScrubbing(client);
  results.locale = await verifyLiveLocaleSwitch(client);
  results.theme = await verifyTheme(client);
  results.hash = await verifyHashRestore(client, origin, archivePath);
  results.responsive = await verifyNarrowLayout(client);

  if (screenshotsDir) {
    results.screenshots = await captureScreenshots(client, origin, archivePath, screenshotsDir);
  }

  if (realArchive) {
    results.real = await verifyRealArchive(client, origin, realArchive, realPassphrase);
  }

  // The classic player (screenshot mode) is not under test here.
  results.csp = cspViolations.filter((entry) => entry.page.includes("ui=next"));
  assert(results.csp.length === 0, "CSP violations in the React player", results.csp);

  assert(exceptions.length === 0, "Runtime exceptions in the player page", exceptions);
  console.log("Player next E2E passed:", JSON.stringify(results, null, 2));
  await cleanup();
}

/**
 * `Function(...)` calls third-party code ships that never run under the Player. Each match is
 * checked against the source around it, so a new call site fails the scan until it is explained.
 */
const ALLOWED_FUNCTION_CALLS = [
  // Zod's JIT capability probe; the entry chunk sets `jitless` before any schema exists (the
  // runtime CSP guard proves the probe never runs).
  { label: "zod allowsEval probe", pattern: /Function\((``|"")\)/u },
  // jszip's bundled setImmediate polyfill compiles a *string* callback; jszip passes functions.
  {
    label: "setImmediate string callback",
    pattern: /typeof ([\w$]+)!=[`"']function[`"']&&\(\1=Function\([`"']{2}\+\1\)\)/u
  }
];

function findForbiddenCode(source) {
  const hits = [];

  if (/(?<![\w$.])eval\(/u.test(source)) {
    hits.push("eval");
  }

  if (/WebAssembly/u.test(source)) {
    hits.push("WebAssembly");
  }

  for (const match of source.matchAll(/(?<![\w$.])Function\(/gu)) {
    const around = source.slice(Math.max(0, match.index - 60), match.index + 40);

    if (!ALLOWED_FUNCTION_CALLS.some(({ pattern }) => pattern.test(around))) {
      hits.push(`Function constructor: ${around}`);
    }
  }

  return hits;
}

/**
 * The Vite build: a tiny entry, code-split chunks and CSS files, and nothing the CSP forbids
 * (eval, the Function constructor, WebAssembly) in any chunk.
 */
async function verifyBuildOutput(dir) {
  const assets = await readdir(resolve(dir, "assets"));
  const scripts = [
    "main.js",
    ...assets.filter((name) => name.endsWith(".js")).map((name) => `assets/${name}`)
  ];
  const forbidden = [];

  for (const name of scripts) {
    const source = await readFile(resolve(dir, name), "utf8");
    forbidden.push(...findForbiddenCode(source).map((hit) => `${name}: ${hit}`));
  }

  const stylesheets = assets.filter((name) => name.endsWith(".css"));
  assert(forbidden.length === 0, "The build contains code the CSP forbids", forbidden);
  assert(stylesheets.length >= 2, "Expected CSS files for the classic and the React UI", assets);
  assert(scripts.length > 2, "Expected a code-split build (entry + lazy chunks)", scripts);
  return { scripts: scripts.length, stylesheets: stylesheets.length };
}

async function navigate(client, url) {
  await client.send("Page.navigate", { url });
  await waitFor(
    async () =>
      (await client.evaluate(`Boolean(document.querySelector('${testId("player-next")}'))`))
        ? true
        : null,
    20_000,
    100,
    `React player did not mount at ${url}`
  );
}

/** A full page load even when the URL differs from the current one only in its hash. */
async function navigateFresh(client, url) {
  await client.send("Page.navigate", { url: "about:blank" });
  await sleep(200);
  await navigate(client, url);
}

async function setViewport(client, width, height) {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false
  });
}

async function verifyEmptyState(client, url) {
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

async function setFileInput(client, archivePath) {
  const { result } = await client.send("Runtime.evaluate", {
    expression: `document.querySelector('${testId("archive-input")}')`
  });

  if (!result?.objectId) {
    throw new Error("archive input not found");
  }

  await client.send("DOM.setFileInputFiles", { files: [archivePath], objectId: result.objectId });
}

async function typePassphrase(client, value) {
  await client.evaluate(`document.querySelector('${testId("passphrase-input")}').focus()`);
  await client.send("Input.insertText", { text: value });
  await client.evaluate(`document.querySelector('${testId("passphrase-submit")}').click()`);
}

async function waitForSelector(client, selector, timeoutMs, message) {
  return waitFor(
    async () =>
      (await client.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`))
        ? true
        : null,
    timeoutMs,
    100,
    message
  );
}

async function openEncrypted(client, archivePath, passphrase) {
  await setFileInput(client, archivePath);
  await waitForSelector(
    client,
    testId("passphrase-dialog"),
    15_000,
    "Passphrase dialog did not open"
  );
  await typePassphrase(client, passphrase);
  await waitForSelector(client, testId("stage"), 20_000, "Archive did not load");
}

async function verifyEncryptedOpen(client, archivePath) {
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

async function readSnapshot(client) {
  return client.evaluate(`(() => {
    const q = (id) => document.querySelector('[data-testid="' + id + '"]');
    const all = (id) => [...document.querySelectorAll('[data-testid="' + id + '"]')];
    return {
      session: q("session")?.textContent ?? "",
      encryption: q("encryption-chip")?.textContent ?? "",
      otherTabs: q("other-tabs-chip")?.textContent ?? "",
      clock: q("clock")?.textContent ?? "",
      chapters: all("chapter").map((node) => node.textContent),
      actionMarks: all("action-mark").length,
      errorTicks: q("lane-errors")?.children.length ?? 0,
      networkBars: q("lane-network")?.children.length ?? 0,
      realtimeTicks: q("lane-realtime")?.children.length ?? 0,
      rows: all("event-row").length,
      selectedRow: document.querySelector('[data-testid="event-row"][aria-selected="true"]')?.dataset.eventId ?? null,
      tab: document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.testid ?? "",
      tabText: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? "",
      media: q("stage")?.dataset.media ?? "",
      cursor: Boolean(q("pointer-cursor")),
      playing: q("play-toggle")?.dataset.playing ?? "",
      live: q("live-region")?.textContent ?? "",
      hash: location.hash,
      lang: document.documentElement.lang,
      theme: document.documentElement.dataset.theme ?? "",
      shortcuts: Boolean(q("shortcuts-dialog")),
      details: q("details-json")?.textContent ?? "",
      unloads: window.__unloads,
      marker: window.__e2eMarker ?? null
    };
  })()`);
}

async function verifyLoadedLayout(client) {
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
  return snapshot;
}

async function press(client, key, options = {}) {
  const code = options.code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key);
  const text = key.length === 1 ? key : undefined;
  const modifiers = options.shift ? 8 : 0;
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    text,
    modifiers,
    windowsVirtualKeyCode: options.keyCode ?? 0
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: options.keyCode ?? 0
  });
}

async function waitForSnapshot(client, predicate, message, timeoutMs = 8_000) {
  return waitFor(
    async () => {
      const value = await readSnapshot(client);
      return predicate(value) ? value : null;
    },
    timeoutMs,
    100,
    message
  );
}

async function verifyKeyboard(client) {
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

async function verifyScrubbing(client) {
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

async function verifyLiveLocaleSwitch(client) {
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

async function verifyTheme(client) {
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

async function verifyHashRestore(client, origin, archivePath) {
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

async function verifyNarrowLayout(client) {
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

async function captureScreenshots(client, origin, archivePath, outDir) {
  await mkdir(outDir, { recursive: true });
  const shots = [];

  for (const [width, height] of [
    [1440, 900],
    [1920, 1080]
  ]) {
    await setViewport(client, width, height);

    for (const lang of ["en", "ru"]) {
      await client.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: "light" }]
      });
      await client.send("Page.navigate", { url: `${origin}/?lang=${lang}` });
      await waitForSelector(client, "#archive-input", 20_000, "Classic player did not start");
      await setClassicFile(client, archivePath);
      await waitForSelector(
        client,
        "#archive-passphrase-dialog[open]",
        15_000,
        "Classic passphrase dialog did not open"
      );
      await client.evaluate("document.querySelector('#archive-passphrase-input').focus()");
      await client.send("Input.insertText", { text: SYNTHETIC_PASSPHRASE });
      await client.evaluate("document.querySelector('#archive-passphrase-confirm').click()");
      await waitFor(
        async () =>
          (await client.evaluate(`document.querySelectorAll('#timeline-list .event').length > 0`))
            ? true
            : null,
        20_000,
        150,
        "Classic player did not load"
      );
      await sleep(400);
      shots.push(await screenshot(client, outDir, `before-classic-${width}-light-${lang}.png`));

      for (const theme of ["light", "dark"]) {
        // The shot is taken at the first 401 (t=10.89); waitForSnapshot below checks the clock.
        await client.evaluate("localStorage.removeItem('webblackbox.player.theme')");
        await client.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: theme }]
        });
        await navigateFresh(client, `${origin}/?ui=next&lang=${lang}#t=10.89&sel=req:90080.1706`);
        await openEncrypted(client, archivePath, SYNTHETIC_PASSPHRASE);
        await waitForSnapshot(
          client,
          (value) => value.media === "screenshot" && /0:10[.,]89/.test(value.clock),
          "Stage did not show the screenshot at 10.89 s"
        );
        await client.evaluate("document.fonts.ready");
        await sleep(400);
        shots.push(await screenshot(client, outDir, `after-next-${width}-${theme}-${lang}.png`));
      }
    }
  }

  await setViewport(client, 390, 844);
  await client.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }]
  });
  await navigateFresh(client, `${origin}/?ui=next&lang=en#t=10.89&sel=req:90080.1706`);
  await openEncrypted(client, archivePath, SYNTHETIC_PASSPHRASE);
  await sleep(400);
  shots.push(await screenshot(client, outDir, "after-next-390-light-en.png"));
  await setViewport(client, 1440, 900);
  return shots;
}

async function setClassicFile(client, archivePath) {
  const { result } = await client.send("Runtime.evaluate", {
    expression: "document.querySelector('#archive-input')"
  });
  await client.send("DOM.setFileInputFiles", { files: [archivePath], objectId: result.objectId });
  // setFileInputFiles fires `change` itself; a second event would start a second load.
}

async function screenshot(client, outDir, name) {
  const { data } = await client.send("Page.captureScreenshot", { format: "png" });
  const path = resolve(outDir, name);
  await writeFile(path, Buffer.from(data, "base64"));
  return path;
}

async function verifyRealArchive(client, origin, archivePath, passphrase) {
  const outDir = resolve(artifactsDir, "real-archive");
  await mkdir(outDir, { recursive: true });
  await setViewport(client, 1440, 900);
  // Mid-session (the real recording has no frame at 0 s); the classic error rule finds no errors
  // in it (console errors carry data.level — R2), so the check seeks by the URL hash.
  await navigateFresh(client, `${origin}/?ui=next&lang=en#t=10.89`);
  await openEncrypted(client, archivePath, passphrase);
  const snapshot = await waitForSnapshot(
    client,
    (value) => value.rows > 0 && value.media !== "none",
    "Real archive did not render",
    30_000
  );
  await press(client, "l");
  const stepped = await waitForSnapshot(
    client,
    (value) => value.selectedRow !== null,
    "L selected nothing"
  );
  await sleep(800);
  const shot = await screenshot(client, outDir, "real-archive-1440.png");
  return {
    clock: snapshot.clock,
    chapters: snapshot.chapters,
    rows: snapshot.rows,
    media: snapshot.media,
    actionMarks: snapshot.actionMarks,
    networkBars: snapshot.networkBars,
    realtimeTicks: snapshot.realtimeTicks,
    stepped: stepped.live.slice(0, 80),
    screenshot: shot
  };
}

function assert(condition, message, details) {
  if (!condition) {
    throw new Error(
      `${message}${details === undefined ? "" : ` | details=${JSON.stringify(details)}`}`
    );
  }
}

async function cleanup() {
  state.client?.close();
  state.client = null;

  if (state.targetId && state.baseUrl) {
    await closeTarget(state.baseUrl, state.targetId);
  }

  if (state.chrome) {
    await terminateChromeProcess(state.chrome.proc);
    await new Promise((resolvePromise) => state.chrome.logStream.end(resolvePromise));
    state.chrome = null;
  }

  if (state.server) {
    await new Promise((resolvePromise) => state.server.close(() => resolvePromise()));
    state.server = null;
  }
}
