#!/usr/bin/env node

// E2E: real (CDP-dispatched) pointer input on the e2e demo is recorded in lite and full mode under
// a Full-capture-like profile: clicks with readable targets and geometry, right and middle clicks,
// a long press, a pointer drag, wheel, hover dwell, mousemove samples and click reactions. The
// player SDK finds the rage/dead clicks, and the generated Playwright script replays on the demo.

import { spawn, spawnSync } from "node:child_process";
import { constants, createWriteStream } from "node:fs";
import { access, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(root, "..");
const repoRoot = resolve(appRoot, "..", "..");
const demoDir = resolve(appRoot, "e2e-demo");

const extensionDir = process.env.WB_E2E_EXTENSION_DIR ?? resolve(appRoot, "build");
const remotePort = Number(process.env.WB_E2E_REMOTE_PORT ?? "9233");
const headless = (process.env.WB_E2E_HEADLESS ?? "1") !== "0";
const modes = (process.env.WB_E2E_POINTER_MODES ?? "lite,full")
  .split(",")
  .map((mode) => mode.trim())
  .filter((mode) => mode === "lite" || mode === "full");
const runId = Date.now();
const profileDir = process.env.WB_E2E_PROFILE_DIR ?? `/tmp/webblackbox-pointer-${runId}`;
const downloadDir = `/tmp/webblackbox-pointer-downloads-${runId}`;
const chromeLogPath = process.env.WB_E2E_LOG ?? `/tmp/webblackbox-pointer-${runId}.log`;
const baseUrl = `http://127.0.0.1:${remotePort}`;
const passphrase = "webblackbox-pointer-e2e-passphrase";
const VIEWPORT = { width: 1280, height: 1400 };
const POINTER_PROFILE_ID = "e2e-pointer-profile";
const POINTER_RULE = {
  id: "e2e-pointer",
  name: "Pointer E2E",
  profileId: POINTER_PROFILE_ID,
  priority: 10,
  enabled: true,
  match: { hosts: ["127.0.0.1:*"] }
};
const REQUIRED_TYPES = [
  "user.click",
  "user.pointerdown",
  "user.pointerup",
  "user.contextmenu",
  "user.auxclick",
  "user.drag.start",
  "user.drag.end",
  "user.wheel",
  "user.hover",
  "user.click.reaction",
  "user.mousemove"
];
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};
const BUTTON_MASKS = { left: 1, right: 2, middle: 4 };
// Every wait is bounded: a CDP command, the export answer and the whole run each have a deadline.
const COMMAND_TIMEOUT_MS = Number(process.env.WB_E2E_COMMAND_TIMEOUT_MS ?? "30000");
const EXPORT_TIMEOUT_MS = Number(process.env.WB_E2E_EXPORT_TIMEOUT_MS ?? "120000");
const RUN_TIMEOUT_MS = Number(process.env.WB_E2E_POINTER_TIMEOUT_MS ?? "600000");
const CHROME_LOG_TAIL_LINES = 40;
const CHROME_EXIT_GRACE_MS = 5_000;

const chromeCandidates = [
  process.env.WB_E2E_CHROME_BIN,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "google-chrome",
  "chromium"
].filter(Boolean);

const state = { chrome: null, logStream: null, server: null, clients: [] };

const watchdog = setTimeout(() => {
  void fail(
    new Error(`run did not finish within ${RUN_TIMEOUT_MS} ms (WB_E2E_POINTER_TIMEOUT_MS)`)
  );
}, RUN_TIMEOUT_MS);

// A killed run must not leave its Chrome holding the DevTools port for the next run.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => void fail(new Error(`interrupted by ${signal}`)));
}

main()
  .then(() => clearTimeout(watchdog))
  .catch(fail);

async function fail(error) {
  clearTimeout(watchdog);
  console.error("Pointer E2E failed:", error instanceof Error ? error.message : String(error));
  await printChromeLogTail();
  await cleanup();
  process.exit(1);
}

async function printChromeLogTail() {
  try {
    const lines = (await readFile(chromeLogPath, "utf8")).trimEnd().split("\n");
    console.error(`Chrome log tail (${chromeLogPath}):`);
    console.error(lines.slice(-CHROME_LOG_TAIL_LINES).join("\n"));
  } catch {
    console.error(`Chrome log unavailable: ${chromeLogPath}`);
  }
}

async function main() {
  assert(modes.length > 0, "WB_E2E_POINTER_MODES selects no mode (use lite, full or both)");
  await access(resolve(extensionDir, "manifest.json"), constants.R_OK);
  const { WebBlackboxPlayer } = await import(
    pathToFileURL(resolve(repoRoot, "packages/player-sdk/dist/index.js")).href
  );
  const { DEFAULT_REDACTION_PROFILE } = await import(
    pathToFileURL(resolve(repoRoot, "packages/protocol/dist/index.js")).href
  );
  const pointerProfile = createPointerProfile(DEFAULT_REDACTION_PROFILE);
  const appPort = await startDemoServer();
  const demoUrl = `http://127.0.0.1:${appPort}/`;

  await assertDevToolsPortFree();
  await rm(profileDir, { recursive: true, force: true });
  await mkdir(profileDir, { recursive: true });
  await mkdir(downloadDir, { recursive: true });
  startChrome(await resolveChromeBinary(chromeCandidates));

  const version = await waitFor(
    () => fetchJson(`${baseUrl}/json/version`).then((v) => (v?.Browser ? v : null)),
    20_000,
    "Chrome DevTools endpoint not ready"
  );
  console.log(`Chrome: ${version.Browser}`);

  const browser = await connect(version.webSocketDebuggerUrl);
  await browser.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDir,
    eventsEnabled: true
  });

  const swTarget = await waitFor(
    async () =>
      (await fetchJson(`${baseUrl}/json/list`)).find(
        (target) => target?.type === "service_worker" && target.url?.endsWith("/sw.js")
      ) ?? null,
    20_000,
    "Extension service worker not found"
  );
  step("service worker found");
  const extensionId = /^chrome-extension:\/\/([^/]+)\//.exec(swTarget.url)?.[1];
  const sw = await connect(swTarget.webSocketDebuggerUrl);
  const swExceptions = [];
  await sw.send("Runtime.enable");
  step("sw runtime enabled");
  sw.on("Runtime.exceptionThrown", (params) => {
    swExceptions.push(params?.exceptionDetails?.text ?? "unknown");
  });

  // A regular page has to exist before the extension page target answers CDP (as in the QA e2e).
  await openTarget(demoUrl);
  const popup = await connect(
    (await openTarget(`chrome-extension://${extensionId}/popup.html`)).webSocketDebuggerUrl
  );
  step("popup opened");
  await popup.send("Runtime.enable");
  await sleep(1_000);
  await popup.evaluate(`
    chrome.storage.local.set({
      "webblackbox.profiles": {
        schemaVersion: 2,
        defaultProfileId: "default",
        profiles: [${JSON.stringify(pointerProfile)}],
        rules: [${JSON.stringify(POINTER_RULE)}],
        extendedCaptureHosts: []
      }
    }).then(() => true)
  `);

  step("profiles store written");
  const results = [];

  for (const mode of modes) {
    results.push(await runMode({ mode, demoUrl, popup, WebBlackboxPlayer }));
  }

  assert(swExceptions.length === 0, "Service worker threw", swExceptions);

  for (const result of results) {
    console.log(`[${result.mode}] archive ${result.archivePath} (${result.bytes} bytes)`);
    console.log(`[${result.mode}] pointer events: ${JSON.stringify(result.counts)}`);
    console.log(`[${result.mode}] click target: ${JSON.stringify(result.clickTarget)}`);
    console.log(`[${result.mode}] rage clicks: ${result.rage}, dead clicks: ${result.dead}`);
    console.log(
      `[${result.mode}] Playwright replay: ${result.replay.actions} actions, ${result.replay.pulse}`
    );
  }

  console.log(`Chrome log: ${chromeLogPath}`);
  console.log("Pointer capture E2E passed.");
  await cleanup();
}

/**
 * The Full capture preset with a 256 KiB body cap. With the preset's 1 MiB cap a full-mode export
 * never answers (also on the base branch, independent of pointer capture); tracked separately.
 */
function createPointerProfile(redaction) {
  return {
    id: POINTER_PROFILE_ID,
    name: "Pointer E2E",
    base: "full",
    categories: {
      actions: "allow",
      inputs: "allow",
      dom: "allow",
      screenshots: "allow",
      screenRecordings: "allow",
      console: "allow",
      network: "body-allowlist",
      storage: "allow",
      indexedDb: "names-only",
      cookies: "names-only",
      cdp: "full",
      heapProfiles: "off"
    },
    redaction,
    unmaskSelectors: [],
    network: {
      bodyMimeAllowlist: ["text/*", "application/json"],
      bodyMaxBytes: 256 * 1024,
      includeUrls: [],
      excludeUrls: []
    },
    pointer: { mousemoveHz: 60, hover: true, drag: true, wheel: true },
    sampling: {},
    recorder: {},
    sitePolicies: [],
    export: { encryption: "required", privacyScanner: "block" }
  };
}

async function runMode({ mode, demoUrl, popup, WebBlackboxPlayer }) {
  const target = await openTarget(demoUrl);
  const page = await connect(target.webSocketDebuggerUrl);
  await page.send("Runtime.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 1,
    mobile: false
  });
  await waitForDemo(page);
  step(`[${mode}] demo loaded`);

  const tabId = await popup.evaluate(`
    chrome.tabs.query({}).then((tabs) =>
      tabs.filter((tab) => tab.url?.startsWith(${JSON.stringify(demoUrl)})).pop()?.id ?? null
    )
  `);
  assert(typeof tabId === "number", "Demo tab not found", { tabId });

  const started = await popup.evaluate(
    `chrome.runtime.sendMessage({ kind: "ui.start", tabId: ${tabId}, mode: ${JSON.stringify(mode)}, visualCapture: "none" })`
  );
  assert(started?.ok !== false, `Failed to start ${mode} mode`, started);
  await waitFor(
    () =>
      page.evaluate(
        `document.querySelector('[data-webblackbox-indicator="true"]')?.textContent?.includes("REC ${mode}") || null`
      ),
    25_000,
    `Recording indicator for ${mode} did not appear`
  );
  step(`[${mode}] recording`);
  await sleep(1_500);
  await performPointerScenario(page);
  step(`[${mode}] scenario done`);
  await sleep(2_500);

  const sid = await popup.evaluate(`
    chrome.storage.local.get("webblackbox.runtime.sessions").then(
      (store) =>
        (store["webblackbox.runtime.sessions"] ?? []).find((session) => session.tabId === ${tabId})
          ?.sid ?? null
    )
  `);
  assert(typeof sid === "string", "Active session not found", { sid });
  step(`[${mode}] session ${sid}`);

  const knownFiles = new Set(await readdir(downloadDir));
  const exported = await popup
    .evaluate(
      `
    chrome.runtime.sendMessage({
      kind: "ui.export",
      sid: ${JSON.stringify(sid)},
      passphrase: ${JSON.stringify(passphrase)},
      saveAs: false,
      acknowledgePrivacyFindings: true
    })
  `,
      EXPORT_TIMEOUT_MS
    )
    .catch((error) => {
      throw new Error(`[${mode}] ui.export for ${sid} did not answer: ${error.message}`);
    });
  assert(exported?.ok === true, `Export of the ${mode} session failed`, exported);
  step(`[${mode}] export requested`);
  await popup.evaluate(`chrome.runtime.sendMessage({ kind: "ui.stop", tabId: ${tabId} })`);

  const archivePath = await waitFor(
    async () => {
      const file = (await readdir(downloadDir)).find(
        (name) => !knownFiles.has(name) && !name.endsWith(".crdownload")
      );
      return file ? resolve(downloadDir, file) : null;
    },
    30_000,
    "Exported archive was not downloaded"
  );
  step(`[${mode}] exported ${archivePath}`);
  const bytes = new Uint8Array(await readFile(archivePath));
  const player = await WebBlackboxPlayer.open(bytes, { passphrase });
  const events = player.query();
  const counts = Object.fromEntries(
    REQUIRED_TYPES.map((type) => [type, events.filter((event) => event.type === type).length])
  );
  const missing = REQUIRED_TYPES.filter((type) => counts[type] === 0);
  assert(missing.length === 0, `[${mode}] pointer events missing from the archive`, {
    missing,
    types: [...new Set(events.map((event) => event.type))]
  });

  const pulseClick = events.find(
    (event) => event.type === "user.click" && event.data?.target?.readable?.css === "#pulse-dom"
  );
  assert(pulseClick, `[${mode}] click on #pulse-dom has no readable target`, {
    clicks: events.filter((event) => event.type === "user.click").map((event) => event.data?.target)
  });
  assert(
    pulseClick.data.viewport?.w === VIEWPORT.width &&
      typeof pulseClick.data.pageY === "number" &&
      pulseClick.data.target.rect?.w > 0 &&
      pulseClick.data.target.readable.text === "Pulse DOM",
    `[${mode}] click geometry or readable label missing`,
    pulseClick.data
  );
  assert(
    events.some((event) => event.type === "user.contextmenu" && event.data?.button === 2),
    `[${mode}] right click not recorded`
  );
  assert(
    events.some((event) => event.type === "user.auxclick" && event.data?.button === 1),
    `[${mode}] middle click not recorded`
  );
  assert(
    events.some(
      (event) =>
        event.type === "user.pointerup" &&
        event.data?.longPress === true &&
        event.data.holdMs >= 600
    ),
    `[${mode}] long press not recorded`
  );
  const drag = events.find((event) => event.type === "user.drag.end");
  assert(
    drag?.data?.kind === "pointer" && drag.data.distance >= 100,
    `[${mode}] drag distance`,
    drag
  );
  assert(
    events.some(
      (event) =>
        event.type === "user.click.reaction" &&
        event.data?.clickMono === pulseClick.mono &&
        event.data.mutated === true
    ),
    `[${mode}] the #pulse-dom click has no DOM reaction`
  );

  const signals = player.getPointerSignals();
  assert(signals.rageClicks.length >= 1, `[${mode}] rage click not detected`, signals);
  assert(signals.deadClicks.length >= 1, `[${mode}] dead click not detected`, signals);
  assert(player.generateBugReport().includes("- Rage click:"), `[${mode}] bug report misses rage`);

  const script = player.generatePlaywrightScript({
    includeHarReplay: false,
    startUrl: demoUrl,
    maxActions: 200
  });
  step(`[${mode}] replaying Playwright script`);
  const replay = await replayPlaywrightScript(script);
  assert(replay.actions >= 8, `[${mode}] Playwright replay ran too few actions`, {
    replay,
    script
  });
  assert(/Pulse count: [2-9]/.test(replay.pulse), `[${mode}] replayed clicks did not land`, {
    replay,
    script
  });

  await closeTarget(target.id);

  return {
    mode,
    archivePath,
    bytes: bytes.byteLength,
    counts,
    clickTarget: pulseClick.data.target,
    rage: signals.rageClicks.length,
    dead: signals.deadClicks.length,
    replay
  };
}

async function performPointerScenario(page) {
  const pulse = await elementCenter(page, "#pulse-dom");
  const dashboard = await elementCenter(page, "#load-dashboard");
  const prefs = await elementCenter(page, "#save-prefs");
  const slow = await elementCenter(page, "#load-slow");
  const heading = await elementCenter(page, "h1");
  const eyebrow = await elementCenter(page, ".eyebrow");

  // Pointer path before the first click: mousemove samples.
  for (let step = 0; step <= 12; step += 1) {
    await mouse(page, "mouseMoved", 40 + step * 30, 60 + step * 10);
    await sleep(60);
  }

  await clickAt(page, pulse, "left");
  await sleep(1_200);
  await clickAt(page, dashboard, "right");
  await sleep(300);
  await clickAt(page, prefs, "middle");
  await sleep(300);
  await clickAt(page, pulse, "left", 750);
  await sleep(1_200);

  // Hover dwell over a button, then leave it.
  await mouse(page, "mouseMoved", slow.x, slow.y);
  await sleep(900);
  await mouse(page, "mouseMoved", heading.x, heading.y + 60);
  await sleep(300);

  // Pointer drag across the heading.
  const dragStart = { x: heading.x - 120, y: heading.y };
  await mouse(page, "mouseMoved", dragStart.x, dragStart.y);
  await mouse(page, "mousePressed", dragStart.x, dragStart.y, {
    button: "left",
    buttons: 1,
    clickCount: 1
  });

  for (let step = 1; step <= 10; step += 1) {
    await mouse(page, "mouseMoved", dragStart.x + step * 18, dragStart.y, { buttons: 1 });
    await sleep(30);
  }

  await mouse(page, "mouseReleased", dragStart.x + 180, dragStart.y, {
    button: "left",
    clickCount: 1
  });
  await sleep(400);

  await mouse(page, "mouseWheel", heading.x, heading.y + 200, { deltaX: 0, deltaY: 120 });
  await mouse(page, "mouseWheel", heading.x, heading.y + 200, { deltaX: 0, deltaY: 120 });
  await sleep(300);
  await mouse(page, "mouseWheel", heading.x, heading.y + 200, { deltaX: 0, deltaY: -240 });
  await sleep(500);

  // Rage clicks on text with no handler: also dead clicks.
  for (let index = 0; index < 4; index += 1) {
    await clickAt(page, eyebrow, "left");
    await sleep(120);
  }
}

async function clickAt(page, point, button, holdMs = 0) {
  await mouse(page, "mouseMoved", point.x, point.y);
  await mouse(page, "mousePressed", point.x, point.y, {
    button,
    buttons: BUTTON_MASKS[button],
    clickCount: 1
  });

  if (holdMs > 0) {
    await sleep(holdMs);
  }

  await mouse(page, "mouseReleased", point.x, point.y, { button, clickCount: 1 });
}

async function mouse(page, type, x, y, extra = {}) {
  await page.send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: extra.button ?? "none",
    buttons: extra.buttons ?? 0,
    clickCount: extra.clickCount ?? 0,
    ...(type === "mouseWheel" ? { deltaX: extra.deltaX ?? 0, deltaY: extra.deltaY ?? 0 } : {}),
    ...(extra.modifiers ? { modifiers: extra.modifiers } : {})
  });
}

async function elementCenter(page, selector) {
  const point = await page.evaluate(`
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()
  `);
  assert(point, `Element ${selector} not found on the demo`);
  return point;
}

async function waitForDemo(page) {
  await waitFor(
    () =>
      page.evaluate(
        "(document.readyState === 'complete' && typeof window.__wbDemo === 'object') || null"
      ),
    15_000,
    "Demo page did not load"
  );
}

/**
 * Runs a generated Playwright test against the demo through a CDP-backed stand-in for the
 * Playwright `page` API (the repo has no Playwright runner). Every selector must match exactly
 * one element, or the replay fails.
 */
async function replayPlaywrightScript(script) {
  const target = await openTarget("about:blank");
  const page = await connect(target.webSocketDebuggerUrl);
  await page.send("Runtime.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 1,
    mobile: false
  });

  let actions = 0;
  const cursor = { x: 0, y: 0, buttons: 0 };
  const centerOf = async (selector) => {
    actions += 1;
    const point = await page.evaluate(`
      (() => {
        const matches = document.querySelectorAll(${JSON.stringify(selector)});
        if (matches.length !== 1) return { count: matches.length };
        matches[0].scrollIntoView({ block: "center" });
        const rect = matches[0].getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, count: 1 };
      })()
    `);

    if (point?.count !== 1) {
      throw new Error(`Selector ${selector} matched ${point?.count ?? 0} elements`);
    }

    return point;
  };
  const shimPage = {
    goto: async (url) => {
      await page.send("Page.navigate", { url });
      await sleep(300);
      await waitForDemo(page);
    },
    click: async (selector, options = {}) => {
      await clickAt(page, await centerOf(selector), options.button ?? "left", options.delay ?? 0);
    },
    dblclick: async (selector) => {
      const point = await centerOf(selector);
      await clickAt(page, point, "left");
      await mouse(page, "mousePressed", point.x, point.y, {
        button: "left",
        buttons: 1,
        clickCount: 2
      });
      await mouse(page, "mouseReleased", point.x, point.y, { button: "left", clickCount: 2 });
    },
    hover: async (selector) => {
      const point = await centerOf(selector);
      await mouse(page, "mouseMoved", point.x, point.y);
    },
    dragAndDrop: async (source, destination) => {
      const from = await centerOf(source);
      const to = await centerOf(destination);
      await mouse(page, "mouseMoved", from.x, from.y);
      await mouse(page, "mousePressed", from.x, from.y, {
        button: "left",
        buttons: 1,
        clickCount: 1
      });
      await mouse(page, "mouseMoved", to.x, to.y, { buttons: 1 });
      await mouse(page, "mouseReleased", to.x, to.y, { button: "left", clickCount: 1 });
    },
    fill: async (selector, value) => {
      await centerOf(selector);
      await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
      await page.send("Input.insertText", { text: value });
    },
    evaluate: async (fn, arg) => page.evaluate(`(${fn.toString()})(${JSON.stringify(arg)})`),
    mouse: {
      move: async (x, y, options = {}) => {
        actions += 1;
        const steps = Math.max(1, options.steps ?? 1);
        const from = { x: cursor.x, y: cursor.y };

        for (let step = 1; step <= steps; step += 1) {
          cursor.x = from.x + ((x - from.x) * step) / steps;
          cursor.y = from.y + ((y - from.y) * step) / steps;
          await mouse(page, "mouseMoved", cursor.x, cursor.y, { buttons: cursor.buttons });
        }
      },
      down: async () => {
        cursor.buttons = 1;
        await mouse(page, "mousePressed", cursor.x, cursor.y, {
          button: "left",
          buttons: 1,
          clickCount: 1
        });
      },
      up: async () => {
        cursor.buttons = 0;
        await mouse(page, "mouseReleased", cursor.x, cursor.y, { button: "left", clickCount: 1 });
      },
      wheel: async (deltaX, deltaY) => {
        actions += 1;
        await mouse(page, "mouseWheel", cursor.x, cursor.y, { deltaX, deltaY });
      }
    },
    keyboard: {
      press: async (key) => {
        await page.send("Input.dispatchKeyEvent", { type: "keyDown", key });
        await page.send("Input.dispatchKeyEvent", { type: "keyUp", key });
      },
      down: async (key) => page.send("Input.dispatchKeyEvent", { type: "keyDown", key }),
      up: async (key) => page.send("Input.dispatchKeyEvent", { type: "keyUp", key })
    }
  };
  const shimBrowser = {
    newContext: async () => ({
      routeFromHAR: async () => undefined,
      route: async () => undefined,
      newPage: async () => shimPage,
      close: async () => undefined
    })
  };
  const body = script.replace(/^import .*$/m, "").replaceAll(" as const", "");
  let pending = Promise.resolve();
  const test = (_name, fn) => {
    pending = fn({ browser: shimBrowser });
  };

  await new Function("test", body)(test);
  await pending;
  await sleep(500);

  const pulse = await page.evaluate("document.querySelector('#pulse-target')?.textContent ?? ''");
  await closeTarget(target.id);

  return { actions, pulse };
}

function startDemoServer() {
  return new Promise((resolvePort, reject) => {
    const server = createServer(async (request, response) => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;

      if (path.startsWith("/api/")) {
        request.resume();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, path }));
        return;
      }

      const file = path === "/" ? "index.html" : path.slice(1);

      if (file.includes("..") || !(extname(file) in MIME_TYPES)) {
        response.writeHead(404).end();
        return;
      }

      try {
        const content = await readFile(resolve(demoDir, file));
        response.writeHead(200, { "content-type": MIME_TYPES[extname(file)] });
        response.end(content);
      } catch {
        response.writeHead(404).end();
      }
    });

    state.server = server;
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePort(server.address().port));
  });
}

function startChrome(binary) {
  const args = [
    `--remote-debugging-port=${remotePort}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-component-update",
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "--enable-logging=stderr",
    "about:blank"
  ];

  if (headless) {
    args.unshift("--headless=new");
  }

  state.chrome = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  state.logStream = createWriteStream(chromeLogPath, { flags: "a" });
  state.chrome.stdout?.pipe(state.logStream);
  state.chrome.stderr?.pipe(state.logStream);
}

/**
 * Fails when something already answers on the DevTools port: Chrome would then fail to bind it
 * and the run would silently drive that other browser (e.g. one left over by a killed run).
 */
async function assertDevToolsPortFree() {
  const occupant = await fetchJson(`${baseUrl}/json/version`).catch(() => null);
  assert(
    occupant === null,
    `DevTools port ${remotePort} is already in use (a Chrome left over from an earlier run?); ` +
      "stop it or set WB_E2E_REMOTE_PORT",
    occupant?.Browser
  );
}

async function resolveChromeBinary(candidates) {
  for (const candidate of candidates) {
    if (isAbsolute(candidate)) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }

    const which = spawnSync("which", [candidate], { encoding: "utf8" });

    if (which.status === 0 && which.stdout.trim()) {
      return which.stdout.trim().split("\n")[0];
    }
  }

  throw new Error("Chrome binary not found. Set WB_E2E_CHROME_BIN.");
}

async function openTarget(url) {
  return fetchJson(`${baseUrl}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
}

async function closeTarget(targetId) {
  await fetch(`${baseUrl}/json/close/${targetId}`).catch(() => undefined);
}

async function connect(wsUrl) {
  const client = new CdpClient(wsUrl);
  await client.connect();
  state.clients.push(client);
  return client;
}

async function fetchJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(6_000) });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.json();
}

async function waitFor(fn, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const result = await fn();

      if (result !== null && result !== undefined) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(250);
  }

  throw new Error(lastError instanceof Error ? `${message}: ${lastError.message}` : message);
}

function assert(condition, message, details) {
  if (!condition) {
    throw new Error(details === undefined ? message : `${message} | ${JSON.stringify(details)}`);
  }
}

function step(message) {
  console.log(`- ${message}`);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** SIGTERM, then SIGKILL after a grace period, so the DevTools port is free when this returns. */
async function stopChrome(chrome) {
  if (!chrome || chrome.exitCode !== null || chrome.signalCode !== null) {
    return;
  }

  const exited = new Promise((resolveExit) => chrome.once("exit", resolveExit));
  chrome.kill("SIGTERM");
  const timer = setTimeout(() => chrome.kill("SIGKILL"), CHROME_EXIT_GRACE_MS);
  await exited;
  clearTimeout(timer);
}

async function cleanup() {
  for (const client of state.clients.splice(0)) {
    client.close();
  }

  await stopChrome(state.chrome);
  state.chrome = null;
  state.server?.close();
  state.server = null;

  if (state.logStream) {
    await new Promise((resolveEnd) => state.logStream.end(resolveEnd));
    state.logStream = null;
  }
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.sequence = 0;
    this.pending = new Map();
    this.handlers = new Map();
  }

  connect() {
    return new Promise((resolveOpen, reject) => {
      const socket = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => {
        reject(new Error(`WebSocket did not open within ${COMMAND_TIMEOUT_MS} ms: ${this.wsUrl}`));
        socket.close();
      }, COMMAND_TIMEOUT_MS);
      this.socket = socket;
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolveOpen();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`WebSocket failed: ${this.wsUrl}`));
      });
      socket.addEventListener("close", () => this.rejectPending(`socket closed: ${this.wsUrl}`));
      socket.addEventListener("message", (event) => {
        const payload = JSON.parse(String(event.data));

        if (typeof payload.id === "number") {
          const pending = this.pending.get(payload.id);
          this.pending.delete(payload.id);

          if (payload.error) {
            pending?.reject(new Error(payload.error.message ?? "CDP error"));
          } else {
            pending?.resolve(payload.result);
          }

          return;
        }

        for (const handler of this.handlers.get(payload.method) ?? []) {
          handler(payload.params ?? {});
        }
      });
    });
  }

  on(method, handler) {
    this.handlers.set(method, [...(this.handlers.get(method) ?? []), handler]);
  }

  send(method, params = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
    const id = ++this.sequence;

    return new Promise((resolveSend, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} got no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      const settle = (callback) => (value) => {
        clearTimeout(timer);
        callback(value);
      };
      this.pending.set(id, { resolve: settle(resolveSend), reject: settle(reject) });

      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        settle(reject)(error);
      }
    });
  }

  rejectPending(reason) {
    for (const pending of this.pending.values()) {
      pending.reject(new Error(reason));
    }

    this.pending.clear();
  }

  async evaluate(expression, timeoutMs = COMMAND_TIMEOUT_MS) {
    const result = await this.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      timeoutMs
    );

    if (result?.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      );
    }

    return result?.result?.value;
  }

  close() {
    this.socket?.close();
  }
}
