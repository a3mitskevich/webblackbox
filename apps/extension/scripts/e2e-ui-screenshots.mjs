#!/usr/bin/env node
/**
 * UI screenshot regression for the popup, options and sessions pages (IMPROVEMENT_PLAN 3.10).
 *
 * Drives headless Chrome over CDP with the built extension loaded. Popup and sessions states are
 * deterministic: `chrome.runtime.connect`, `chrome.runtime.sendMessage`, `chrome.tabs.query` and
 * `Date.now` are stubbed with fixture data before the page scripts run, so no product code needs
 * test hooks. Options pages use a fresh profile (defaults).
 *
 * Always enforced: the popup fits 360×600 without scrolling in every state, and no page scrolls
 * horizontally at its width. Pixel comparison against `e2e-baselines/ui/*.png` runs inside Chrome
 * (canvas, block-averaged diff) with a ratio tolerance. Baselines record a font/Chrome fingerprint;
 * on a machine with a different fingerprint pixel mismatches are reported as warnings unless
 * WB_UI_SHOTS_STRICT=1.
 *
 * Env:
 *   WB_E2E_CHROME_BIN       Chrome binary (required on Linux; defaults to macOS Chrome path)
 *   WB_UI_SHOTS_EXTENSION   unpacked extension dir (default: apps/extension/build)
 *   WB_UI_SHOTS_OUT         output dir for actual/diff images (default: OS temp dir)
 *   WB_UI_SHOTS_UPDATE=1    write actual images as the new baselines
 *   WB_UI_SHOTS_STRICT=1    fail on pixel mismatch even when the fingerprint differs
 *   WB_UI_SHOTS_TOLERANCE   max ratio of differing 4×4 blocks (default 0.01)
 *   WB_UI_SHOTS_ASSERT=0    report invariant violations without failing (e.g. "before" shots)
 *   WB_UI_SHOTS_COMPARE=0   skip the baseline comparison
 *   WB_UI_SHOTS_LANG        UI language (default en-US)
 *   WB_UI_SHOTS_DARK=1      emulate prefers-color-scheme: dark (names get a -dark suffix; no
 *                           baselines are kept for it, use with WB_UI_SHOTS_COMPARE=0)
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(scriptDir, "..");
const extensionDir = resolve(process.env.WB_UI_SHOTS_EXTENSION ?? join(extensionRoot, "build"));
const baselineDir = join(extensionRoot, "e2e-baselines", "ui");
const chromeBin =
  process.env.WB_E2E_CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const updateBaselines = process.env.WB_UI_SHOTS_UPDATE === "1";
const strict = process.env.WB_UI_SHOTS_STRICT === "1";
const assertInvariants = process.env.WB_UI_SHOTS_ASSERT !== "0";
const compareBaselines = process.env.WB_UI_SHOTS_COMPARE !== "0" && !updateBaselines;
const tolerance = Number(process.env.WB_UI_SHOTS_TOLERANCE ?? "0.01");
const uiLanguage = process.env.WB_UI_SHOTS_LANG ?? "en-US";
const darkTheme = process.env.WB_UI_SHOTS_DARK === "1";
const POPUP_WIDTH = 360;
const POPUP_HEIGHT = 600;
const SETTLE_MS = 700;
const CDP_TIMEOUT_MS = 30_000;

const FIXED_NOW = Date.UTC(2026, 8, 21, 10, 30, 0);
const MINUTE = 60_000;
const TAB = { id: 17, url: "https://shop.example.com/cart", title: "Cart · Example Shop" };
const CATALOG = [
  { id: "default", name: "Default", base: "lite", extended: false, readOnly: false },
  { id: "builtin:lite", name: "Lite", base: "lite", extended: false, readOnly: true },
  { id: "builtin:full", name: "Full", base: "full", extended: false, readOnly: true },
  { id: "builtin:qa", name: "QA", base: "full", extended: true, readOnly: true },
  { id: "builtin:full-capture", name: "Full capture", base: "full", extended: true, readOnly: true }
];
const PREVIEW_DEFAULT = {
  kind: "sw.profile-preview",
  catalog: CATALOG,
  selection: { id: "default", name: "Default", base: "lite", source: "default", extended: false }
};
const PREVIEW_RULE = {
  kind: "sw.profile-preview",
  catalog: CATALOG,
  selection: {
    id: "builtin:qa",
    name: "QA",
    base: "full",
    source: "rule",
    ruleName: "Stage",
    extended: true
  }
};
const SESSION_BASE = {
  sid: "wb-1790001234-a1b2c3d4",
  tabId: TAB.id,
  mode: "full",
  url: TAB.url,
  title: TAB.title,
  ringBufferMinutes: 10,
  eventCount: 1843,
  errorCount: 3,
  budgetAlertCount: 1,
  sizeBytes: 2_480_000,
  profileName: "QA"
};
const STOPPED_SESSION = {
  ...SESSION_BASE,
  active: false,
  startedAt: FIXED_NOW - 14 * MINUTE,
  stoppedAt: FIXED_NOW - 2 * MINUTE
};
const ACTIVE_SESSION = {
  ...SESSION_BASE,
  active: true,
  startedAt: FIXED_NOW - 4 * MINUTE,
  eventCount: 612,
  errorCount: 1,
  budgetAlertCount: 0,
  sizeBytes: 731_000
};
/** Recording elsewhere while this tab has a stopped session: the tallest popup layout. */
const ACTIVE_OTHER_TAB_SESSION = {
  ...ACTIVE_SESSION,
  sid: "wb-1790004321-0badf00d",
  tabId: 23,
  url: "https://admin.stage.example.com/orders?env=qa",
  title: "Orders · Admin"
};
const START_REJECTED = {
  ok: false,
  error:
    "Cannot attach the debugger to this tab: another DevTools client is already attached. Close DevTools and retry."
};
const SESSIONS_PAGE_FIXTURE = [
  ACTIVE_SESSION,
  { ...STOPPED_SESSION, tags: ["checkout", "bug-1234"], note: "Coupon field rejects valid code" },
  {
    sid: "wb-1789990000-ffee0011",
    tabId: 23,
    mode: "lite",
    active: false,
    startedAt: FIXED_NOW - 26 * 60 * MINUTE,
    stoppedAt: FIXED_NOW - 25 * 60 * MINUTE,
    url: "https://admin.stage.example.com/orders?env=qa",
    title: "Orders · Admin",
    eventCount: 9120,
    errorCount: 0,
    budgetAlertCount: 0,
    sizeBytes: 11_400_000,
    profileName: "Default"
  },
  {
    sid: "wb-1789900000-00aa77bb",
    tabId: 31,
    mode: "full",
    active: false,
    startedAt: FIXED_NOW - 3 * 24 * 60 * MINUTE,
    stoppedAt: FIXED_NOW - 3 * 24 * 60 * MINUTE + 7 * MINUTE,
    url: "http://localhost:5173/login",
    title: "",
    eventCount: 402,
    errorCount: 12,
    budgetAlertCount: 4,
    sizeBytes: 905_000,
    profileName: "Full capture"
  }
];

/** Candidate selectors so the same script captures the previous and the redesigned UI. */
const START_SELECTORS = ["[data-action='start']", "[data-action='start-lite']"];
const LITE_ENGINE_SELECTORS = ["input[name='capture-mode'][value='lite']"];

const POPUP_STATES = [
  { name: "popup-idle", sessions: [], preview: PREVIEW_DEFAULT },
  { name: "popup-ready-rule", sessions: [STOPPED_SESSION], preview: PREVIEW_RULE },
  { name: "popup-recording", sessions: [ACTIVE_SESSION], preview: PREVIEW_RULE },
  {
    name: "popup-passphrase",
    sessions: [STOPPED_SESSION],
    preview: PREVIEW_RULE,
    steps: [{ click: ["[data-action='export']"] }]
  },
  {
    name: "popup-exporting",
    sessions: [STOPPED_SESSION],
    preview: PREVIEW_RULE,
    // Archives are always encrypted: the dialog only submits a passphrase of 8+ characters.
    steps: [
      { click: ["[data-action='export']"] },
      { type: { selector: "#wb-passphrase-input", value: "ui-shots-passphrase" } },
      { click: ["[data-passphrase-submit]"] }
    ]
  },
  {
    name: "popup-other-tab",
    sessions: [ACTIVE_OTHER_TAB_SESSION, STOPPED_SESSION],
    preview: PREVIEW_RULE
  },
  {
    name: "popup-other-tab-error",
    sessions: [ACTIVE_OTHER_TAB_SESSION, STOPPED_SESSION],
    preview: PREVIEW_RULE,
    sendMessageResponse: START_REJECTED,
    steps: [{ click: START_SELECTORS }]
  },
  {
    name: "popup-lite-reload",
    sessions: [],
    preview: PREVIEW_DEFAULT,
    steps: [{ click: LITE_ENGINE_SELECTORS, optional: true }, { click: START_SELECTORS }]
  }
];

const OPTIONS_SECTIONS = ["profiles", "rules", "sensitivity", "sampling", "export"];
const PAGE_SHOTS = [
  { name: "options-420", page: "options.html", width: 420, height: 900 },
  { name: "options-1440", page: "options.html", width: 1440, height: 900 },
  ...OPTIONS_SECTIONS.map((section) => ({
    name: `options-1440-${section}`,
    page: "options.html",
    width: 1440,
    height: 900,
    hash: section,
    requires: `[data-options-section='${section}']`
  })),
  {
    name: "sessions-420",
    page: "sessions.html",
    width: 420,
    height: 900,
    sessions: SESSIONS_PAGE_FIXTURE
  },
  {
    name: "sessions-1440",
    page: "sessions.html",
    width: 1440,
    height: 900,
    sessions: SESSIONS_PAGE_FIXTURE
  }
];

const failures = [];
const warnings = [];
const pendingEvents = [];

await main();

async function main() {
  if (!existsSync(join(extensionDir, "manifest.json"))) {
    throw new Error(`Built extension not found at ${extensionDir}; run pnpm build first.`);
  }

  const outDir = resolve(
    process.env.WB_UI_SHOTS_OUT ?? (await mkdtemp(join(tmpdir(), "wb-ui-shots-")))
  );
  await mkdir(outDir, { recursive: true });
  const extensionId = await resolveExtensionId(extensionDir);
  const chrome = await launchChrome();
  const results = [];

  try {
    const browser = await connectBrowser(chrome.port);
    const fingerprint = await measureFingerprint(browser, extensionId);

    for (const state of POPUP_STATES) {
      results.push(await capturePopupState(browser, extensionId, state, outDir));
    }

    for (const shot of PAGE_SHOTS) {
      results.push(await capturePage(browser, extensionId, shot, outDir));
    }

    if (updateBaselines) {
      await writeBaselines(results, fingerprint);
    } else if (compareBaselines) {
      await compareWithBaselines(browser, results, fingerprint, outDir);
    }

    browser.close();
  } finally {
    chrome.proc.kill();
    await sleep(300);
    await rm(chrome.profileDir, { recursive: true, force: true }).catch(() => undefined);
  }

  for (const result of results.filter(Boolean)) {
    console.log(
      `${result.name.padEnd(26)} ${result.width}x${result.height} content ${result.scrollWidth}x${result.scrollHeight}`
    );
  }

  console.log(`Screenshots: ${outDir}`);
  warnings.forEach((warning) => console.warn(`WARN ${warning}`));

  if (failures.length > 0) {
    failures.forEach((failure) => console.error(`FAIL ${failure}`));
    process.exitCode = 1;
    return;
  }

  console.log("UI screenshot check passed.");
}

async function capturePopupState(browser, extensionId, state, outDir) {
  const page = await openPage(browser, POPUP_WIDTH, POPUP_HEIGHT, {
    sessions: state.sessions,
    preview: state.preview,
    sendMessageResponse: state.sendMessageResponse,
    port: "webblackbox:popup"
  });

  try {
    await navigate(page, `chrome-extension://${extensionId}/popup.html`);

    for (const step of state.steps ?? []) {
      if (step.type) {
        if (!(await typeInto(page, step.type.selector, step.type.value))) {
          failures.push(`${state.name}: ${step.type.selector} not found`);
        }

        continue;
      }

      const clicked = await clickFirst(page, step.click);

      if (!clicked && !step.optional) {
        failures.push(`${state.name}: none of ${step.click.join(", ")} found`);
      }

      await sleep(300);
    }

    const result = await screenshot(page, state.name, POPUP_WIDTH, POPUP_HEIGHT, outDir);
    checkInvariant(
      result.scrollHeight <= POPUP_HEIGHT && result.scrollWidth <= POPUP_WIDTH,
      `${state.name}: popup content ${result.scrollWidth}x${result.scrollHeight} exceeds ${POPUP_WIDTH}x${POPUP_HEIGHT}`
    );
    return result;
  } finally {
    await page.close();
  }
}

async function capturePage(browser, extensionId, shot, outDir) {
  const page = await openPage(browser, shot.width, shot.height, {
    sessions: shot.sessions,
    port: "webblackbox:sessions"
  });

  try {
    const hash = shot.hash ? `#${shot.hash}` : "";
    await navigate(page, `chrome-extension://${extensionId}/${shot.page}${hash}`);

    if (
      shot.requires &&
      !(await page.evaluate(`Boolean(document.querySelector(${JSON.stringify(shot.requires)}))`))
    ) {
      failures.push(`${shot.name}: ${shot.requires} not found (section navigation broken?)`);
      return null;
    }

    const result = await screenshot(page, shot.name, shot.width, shot.height, outDir);
    checkInvariant(
      result.scrollWidth <= shot.width,
      `${shot.name}: horizontal scroll (${result.scrollWidth}px content at ${shot.width}px)`
    );
    return result;
  } finally {
    await page.close();
  }
}

function checkInvariant(ok, message) {
  if (!ok) {
    (assertInvariants ? failures : warnings).push(message);
  }
}

async function screenshot(page, name, width, height, outDir) {
  await sleep(SETTLE_MS);
  const metrics = await page.evaluate(`(() => {
    const root = document.scrollingElement ?? document.documentElement;
    return { scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight };
  })()`);
  const shot = await page.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: {
      x: 0,
      y: 0,
      width: Math.max(width, metrics.scrollWidth),
      height: Math.max(height, metrics.scrollHeight),
      scale: 1
    }
  });
  const file = join(outDir, `${name}${darkTheme ? "-dark" : ""}.png`);
  await writeFile(file, Buffer.from(shot.data, "base64"));
  return { name, width, height, file, data: shot.data, ...metrics };
}

async function writeBaselines(results, fingerprint) {
  await mkdir(baselineDir, { recursive: true });
  const shots = {};

  for (const result of results.filter(Boolean)) {
    await writeFile(join(baselineDir, `${result.name}.png`), Buffer.from(result.data, "base64"));
    shots[result.name] = { width: result.width, height: result.height };
  }

  await writeFile(
    join(baselineDir, "manifest.json"),
    `${JSON.stringify({ fingerprint, shots }, null, 2)}\n`
  );
  console.log(`Baselines written to ${baselineDir}`);
}

async function compareWithBaselines(browser, results, fingerprint, outDir) {
  const manifestPath = join(baselineDir, "manifest.json");

  if (!existsSync(manifestPath)) {
    failures.push(`No baselines at ${baselineDir}; run with WB_UI_SHOTS_UPDATE=1`);
    return;
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const sameMachine = JSON.stringify(manifest.fingerprint) === JSON.stringify(fingerprint);

  if (!sameMachine) {
    warnings.push(
      `Fingerprint ${JSON.stringify(fingerprint)} differs from the baselines' ${JSON.stringify(manifest.fingerprint)}; pixel mismatches are ${strict ? "failures" : "warnings"}.`
    );
  }

  const differ = await openPage(browser, 800, 600, null);

  try {
    await navigate(differ, "about:blank");

    for (const result of results.filter(Boolean)) {
      const baselinePath = join(baselineDir, `${result.name}.png`);

      if (!existsSync(baselinePath)) {
        failures.push(`${result.name}: missing baseline`);
        continue;
      }

      const baseline = (await readFile(baselinePath)).toString("base64");
      const diff = await differ.evaluate(
        `(${diffImagesInPage.toString()})(${JSON.stringify(baseline)}, ${JSON.stringify(result.data)})`
      );

      if (diff.diffPng) {
        await writeFile(
          join(outDir, `${result.name}.diff.png`),
          Buffer.from(diff.diffPng.replace(/^data:image\/png;base64,/, ""), "base64")
        );
      }

      if (!diff.sizeMismatch && diff.ratio <= tolerance) {
        continue;
      }

      const detail = diff.sizeMismatch
        ? `size ${diff.actualSize} vs baseline ${diff.baselineSize}`
        : `${(diff.ratio * 100).toFixed(2)}% of blocks differ (tolerance ${(tolerance * 100).toFixed(2)}%)`;
      (sameMachine || strict ? failures : warnings).push(`${result.name}: ${detail}`);
    }
  } finally {
    await differ.close();
  }
}

/** Runs inside Chrome: 4×4 block averages; a block differs when any channel moves > 24. */
async function diffImagesInPage(baselineBase64, actualBase64) {
  const BLOCK = 4;
  const CHANNEL_THRESHOLD = 24;
  const load = (base64) =>
    new Promise((resolveImage, rejectImage) => {
      const image = new Image();
      image.onload = () => resolveImage(image);
      image.onerror = () => rejectImage(new Error("image decode failed"));
      image.src = `data:image/png;base64,${base64}`;
    });
  const [baseline, actual] = await Promise.all([load(baselineBase64), load(actualBase64)]);

  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    return {
      sizeMismatch: true,
      baselineSize: `${baseline.width}x${baseline.height}`,
      actualSize: `${actual.width}x${actual.height}`,
      ratio: 1,
      diffPng: null
    };
  }

  const draw = (image) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    return { canvas, context, data: context.getImageData(0, 0, image.width, image.height).data };
  };
  const left = draw(baseline).data;
  const right = draw(actual);
  const { width, height } = actual;
  let differing = 0;
  let total = 0;
  right.context.fillStyle = "rgba(255, 0, 64, 0.55)";

  for (let y = 0; y < height; y += BLOCK) {
    for (let x = 0; x < width; x += BLOCK) {
      const sums = [0, 0, 0, 0, 0, 0];
      let count = 0;

      for (let dy = 0; dy < BLOCK && y + dy < height; dy += 1) {
        for (let dx = 0; dx < BLOCK && x + dx < width; dx += 1) {
          const index = ((y + dy) * width + x + dx) * 4;

          for (let channel = 0; channel < 3; channel += 1) {
            sums[channel] += left[index + channel];
            sums[channel + 3] += right.data[index + channel];
          }

          count += 1;
        }
      }

      total += 1;

      if (
        [0, 1, 2].some(
          (channel) => Math.abs(sums[channel] - sums[channel + 3]) / count > CHANNEL_THRESHOLD
        )
      ) {
        differing += 1;
        right.context.fillRect(x, y, BLOCK, BLOCK);
      }
    }
  }

  return {
    sizeMismatch: false,
    ratio: total === 0 ? 0 : differing / total,
    diffPng: differing > 0 ? right.canvas.toDataURL("image/png") : null
  };
}

/** Text widths in the extension's font stack + Chrome major: pixel baselines need both equal. */
async function measureFingerprint(browser, extensionId) {
  const page = await openPage(browser, 800, 600, null);

  try {
    await navigate(page, `chrome-extension://${extensionId}/options.html`);
    const fontProbe = await page.evaluate(`(() => {
      const context = document.createElement("canvas").getContext("2d");
      const family = getComputedStyle(document.body).fontFamily;
      return [12, 13, 16].map((size) => {
        context.font = size + "px " + family;
        const width = context.measureText("WebBlackbox 0123456789 Recording profile 记录").width;
        return Math.round(width * 100) / 100;
      });
    })()`);
    const version = await browser.send("Browser.getVersion");
    return { chrome: String(version.product).split(".")[0], fontProbe };
  } finally {
    await page.close();
  }
}

/** Fixture stubs installed before any page script runs. */
function buildStubSource(fixture) {
  return `(() => {
  const fixture = ${JSON.stringify(fixture)};
  const fixedNow = ${FIXED_NOW};
  Date.now = () => fixedNow;
  const chromeApi = globalThis.chrome;

  if (!chromeApi || !chromeApi.runtime) {
    return;
  }

  const define = (target, key, value) => {
    try {
      Object.defineProperty(target, key, { configurable: true, writable: true, value });
    } catch {
      target[key] = value;
    }
  };
  const handlers = new Set();
  const emit = (message) => handlers.forEach((handler) => handler(message));
  const port = {
    name: fixture.port,
    onMessage: { addListener: (h) => handlers.add(h), removeListener: (h) => handlers.delete(h) },
    onDisconnect: { addListener() {}, removeListener() {} },
    postMessage(message) {
      if (message && message.kind === "ui.request-session-list") {
        setTimeout(() => emit({ kind: "sw.session-list", sessions: fixture.sessions }), 0);
      }

      if (message && message.kind === "ui.resolve-profile" && fixture.preview) {
        setTimeout(() => emit(fixture.preview), 0);
      }
    },
    disconnect() {}
  };

  define(chromeApi.runtime, "connect", () => {
    setTimeout(() => emit({ kind: "sw.session-list", sessions: fixture.sessions }), 0);
    return port;
  });
  define(chromeApi.runtime, "sendMessage", () =>
    fixture.sendMessageResponse ? Promise.resolve(fixture.sendMessageResponse) : new Promise(() => {})
  );

  if (chromeApi.tabs) {
    define(chromeApi.tabs, "query", async () => [
      { id: ${TAB.id}, active: true, url: ${JSON.stringify(TAB.url)}, title: ${JSON.stringify(TAB.title)}, lastAccessed: fixedNow }
    ]);
    define(chromeApi.tabs, "create", async () => ({ id: 99 }));
    define(chromeApi.tabs, "sendMessage", async () => undefined);
  }
})();`;
}

async function openPage(browser, width, height, fixture) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const page = {
    sessionId,
    send: (method, params = {}) => browser.send(method, params, sessionId),
    async evaluate(expression) {
      const result = await browser.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId
      );

      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
        );
      }

      return result.result.value;
    },
    close: () => browser.send("Target.closeTarget", { targetId }).catch(() => undefined)
  };

  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false
  });

  if (darkTheme) {
    await page.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }]
    });
  }

  if (fixture) {
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: buildStubSource({ sessions: [], ...fixture })
    });
  }

  return page;
}

async function navigate(page, url) {
  const loaded = new Promise((resolveEvent) => {
    pendingEvents.push({
      method: "Page.loadEventFired",
      sessionId: page.sessionId,
      resolve: resolveEvent
    });
  });
  await page.send("Page.navigate", { url });
  await Promise.race([loaded, sleep(10_000)]);
  await sleep(SETTLE_MS);
}

async function typeInto(page, selector, value) {
  return page.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});

    if (!(input instanceof HTMLInputElement)) {
      return false;
    }

    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
}

async function clickFirst(page, selectors) {
  return page.evaluate(`(() => {
    for (const selector of ${JSON.stringify(selectors)}) {
      const element = document.querySelector(selector);

      if (element instanceof HTMLElement) {
        element.click();
        return true;
      }
    }

    return false;
  })()`);
}

async function connectBrowser(port) {
  let version;

  for (let attempt = 0; attempt < 100 && !version; attempt += 1) {
    version = await fetch(`http://127.0.0.1:${port}/json/version`)
      .then((response) => response.json())
      .catch(() => undefined);

    if (!version) {
      await sleep(150);
    }
  }

  if (!version) {
    throw new Error("Chrome DevTools endpoint did not come up");
  }

  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", () => rejectOpen(new Error("CDP socket error")), {
      once: true
    });
  });

  let sequence = 0;
  const pending = new Map();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));

    if (typeof message.id === "number" && pending.has(message.id)) {
      const { resolveCall, rejectCall, timer } = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(timer);

      if (message.error) {
        rejectCall(new Error(message.error.message));
      } else {
        resolveCall(message.result);
      }

      return;
    }

    if (typeof message.method === "string") {
      for (const waiter of [...pendingEvents]) {
        if (waiter.method === message.method && waiter.sessionId === message.sessionId) {
          pendingEvents.splice(pendingEvents.indexOf(waiter), 1);
          waiter.resolve(message.params);
        }
      }
    }
  });

  return {
    send(method, params = {}, sessionId) {
      const id = ++sequence;

      return new Promise((resolveCall, rejectCall) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectCall(new Error(`CDP timeout: ${method}`));
        }, CDP_TIMEOUT_MS);
        pending.set(id, { resolveCall, rejectCall, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    close: () => socket.close()
  };
}

async function launchChrome() {
  const port = await reservePort();
  const profileDir = await mkdtemp(join(tmpdir(), "wb-ui-shots-profile-"));
  const args = [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    `--lang=${uiLanguage}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-component-update",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--font-render-hinting=none",
    "--disable-lcd-text",
    ...(process.platform === "linux"
      ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
      : []),
    "about:blank"
  ];
  const proc = spawn(chromeBin, args, {
    stdio: "ignore",
    env: { ...process.env, LANG: `${uiLanguage.replace("-", "_")}.UTF-8` }
  });
  return { proc, port, profileDir };
}

function reservePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(typeof address === "object" && address ? address.port : 0));
    });
  });
}

/** Unpacked extensions with a manifest `key` get an id derived from it. */
async function resolveExtensionId(dir) {
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));

  if (typeof manifest.key !== "string") {
    throw new Error("The extension manifest has no key; build the development profile.");
  }

  return [
    ...createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32)
  ]
    .map((char) => String.fromCharCode(97 + parseInt(char, 16)))
    .join("");
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
