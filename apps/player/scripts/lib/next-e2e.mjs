// Shared helpers of e2e:player-next: CDP input and reads through `data-testid` hooks only.
// Feature scenario files (`src/next/features/<feature>/<feature>.e2e.mjs`) receive them in the
// scenario context (see createScenarioContext), so they never import this file.
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { sleep, waitFor } from "./cdp-harness.mjs";
import { parseCsp, readCsp, serializeCsp, strictStyleCsp, withCsp } from "./csp-policy.mjs";
import { SYNTHETIC_PASSPHRASE } from "./synthetic-session.mjs";

export const testId = (id) => `[data-testid="${id}"]`;

export async function navigate(client, url) {
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
export async function navigateFresh(client, url) {
  await client.send("Page.navigate", { url: "about:blank" });
  await sleep(200);
  await navigate(client, url);
}

export async function setViewport(client, width, height) {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false
  });
}

export async function setFileInput(client, archivePath) {
  const { result } = await client.send("Runtime.evaluate", {
    expression: `document.querySelector('${testId("archive-input")}')`
  });

  if (!result?.objectId) {
    throw new Error("archive input not found");
  }

  await client.send("DOM.setFileInputFiles", { files: [archivePath], objectId: result.objectId });
}

export async function typePassphrase(client, value) {
  await client.evaluate(`document.querySelector('${testId("passphrase-input")}').focus()`);
  await client.send("Input.insertText", { text: value });
  await client.evaluate(`document.querySelector('${testId("passphrase-submit")}').click()`);
}

export async function waitForSelector(client, selector, timeoutMs, message) {
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

export async function openEncrypted(client, archivePath, passphrase) {
  await setFileInput(client, archivePath);
  await waitForSelector(
    client,
    testId("passphrase-dialog"),
    15_000,
    "Passphrase dialog did not open"
  );
  // A click outside (on the backdrop) must not cancel the prompt and drop the file.
  const hit = await client.evaluate(
    `document.elementFromPoint(4, 4)?.classList.contains("dlg-backdrop") ?? false`
  );
  assert(hit, "The point clicked outside the passphrase dialog is not its backdrop");
  for (const type of ["mousePressed", "mouseReleased"]) {
    await client.send("Input.dispatchMouseEvent", {
      type,
      x: 4,
      y: 4,
      button: "left",
      clickCount: 1
    });
  }
  await sleep(150);
  await waitForSelector(
    client,
    testId("passphrase-dialog"),
    1_000,
    "A click outside cancelled the passphrase dialog"
  );
  await typePassphrase(client, passphrase);
  await waitForSelector(client, testId("stage"), 20_000, "Archive did not load");
}

export async function readSnapshot(client) {
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
      selectedFuture: document.querySelector('[data-testid="event-row"][aria-selected="true"]')?.dataset.future ?? null,
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
      details: q("inspector-raw-json")?.textContent ?? "",
      unloads: window.__unloads,
      marker: window.__e2eMarker ?? null
    };
  })()`);
}

export async function press(client, key, options = {}) {
  const code = options.code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key);
  // A printable key types its character; Enter must carry "\r" to activate a focused button.
  const text = key.length === 1 ? key : key === "Enter" ? "\r" : undefined;
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

export async function waitForSnapshot(client, predicate, message, timeoutMs = 8_000) {
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

export async function screenshot(client, outDir, name) {
  const { data } = await client.send("Page.captureScreenshot", { format: "png" });
  const path = resolve(outDir, name);
  await writeFile(path, Buffer.from(data, "base64"));
  return path;
}

export function assert(condition, message, details) {
  if (!condition) {
    throw new Error(
      `${message}${details === undefined ? "" : ` | details=${JSON.stringify(details)}`}`
    );
  }
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
  },
  // Shiki's JavaScript/TypeScript TextMate grammars: the word inside a regex *string*
  // (`Function(?![$_[:alnum:]])`), never a call.
  { label: "Shiki grammar regex text", pattern: /Function\(\?!\[\$_\[:alnum:\]\]\)/u }
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
export async function verifyBuildOutput(dir) {
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

/** Presses the left button on the centre of `selector`, moves by (dx, dy) and releases. */
export async function dragBy(client, selector, dx, dy) {
  const box = await client.evaluate(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  const steps = 6;

  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: box.x,
    y: box.y
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: box.x,
    y: box.y,
    button: "left",
    clickCount: 1
  });

  for (let step = 1; step <= steps; step += 1) {
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: box.x + (dx * step) / steps,
      y: box.y + (dy * step) / steps,
      button: "left",
      buttons: 1
    });
  }

  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: box.x + dx,
    y: box.y + dy,
    button: "left",
    clickCount: 1
  });
}

/** Moves the pointer onto the centre of `selector` (hover). */
export async function hover(client, selector) {
  const box = await client.evaluate(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
}

/** Opens a fresh page of the React player with the synthetic encrypted archive loaded. */
export async function openSyntheticArchive(client, { origin, archivePath, hash = "", query = "" }) {
  await navigateFresh(client, `${origin}/?ui=next&lang=en${query}${hash}`);
  await openEncrypted(client, archivePath, SYNTHETIC_PASSPHRASE);
}

/**
 * What a feature scenario gets (`run(ctx)`): the CDP client and helpers bound to it. Scenarios
 * drive the player only through `data-testid` hooks and return a small JSON-able result.
 */
export function createScenarioContext({ client, origin, archivePath, artifactsDir }) {
  return {
    client,
    origin,
    archivePath,
    artifactsDir,
    testId,
    sleep,
    assert,
    evaluate: (expression) => client.evaluate(expression),
    press: (key, options) => press(client, key, options),
    snapshot: () => readSnapshot(client),
    waitForSnapshot: (predicate, message, timeoutMs) =>
      waitForSnapshot(client, predicate, message, timeoutMs),
    waitForSelector: (selector, message, timeoutMs = 8_000) =>
      waitForSelector(client, selector, timeoutMs, message),
    click: (id) => client.evaluate(`document.querySelector('${testId(id)}').click()`),
    hover: (selector) => hover(client, selector),
    dragBy: (selector, dx, dy) => dragBy(client, selector, dx, dy),
    setViewport: (width, height) => setViewport(client, width, height),
    // Feature panels bring their own markup and libraries: every scenario page is served under
    // the strict style policy, so a panel that injects a <style> fails the run.
    openSynthetic: (options = {}) =>
      openSyntheticArchive(client, {
        origin,
        archivePath,
        ...options,
        query: `${STRICT_CSP_QUERY}${options.query ?? ""}`
      })
  };
}

/** `src/next/features/<feature>/<feature>.e2e.mjs`, in feature-name order (the run order). */
export async function findFeatureScenarioFiles(featuresDir) {
  const entries = await readdir(featuresDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries
    .filter((candidate) => candidate.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const file = join(featuresDir, entry.name, `${entry.name}.e2e.mjs`);

    try {
      await access(file);
      files.push({ feature: entry.name, file });
    } catch {
      // This feature has no e2e scenarios (yet).
    }
  }

  return files;
}

/**
 * Imports the scenario files and checks their shape:
 * `export default { feature: "<folder>", scenarios: [{ name, run(ctx) }] }`.
 * `only` (WB_E2E_NEXT_FEATURES="feed,network") keeps just those features.
 */
export async function loadFeatureScenarios(files, only = null) {
  const wanted = only
    ? new Set(
        only
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean)
      )
    : null;
  const suites = [];

  for (const { feature, file } of files) {
    if (wanted && !wanted.has(feature)) {
      continue;
    }

    const suite = (await import(pathToFileURL(file).href)).default;
    const valid =
      suite?.feature === feature &&
      Array.isArray(suite.scenarios) &&
      suite.scenarios.length > 0 &&
      suite.scenarios.every(
        (scenario) => typeof scenario?.name === "string" && typeof scenario?.run === "function"
      );

    if (!valid) {
      throw new Error(
        `${file} must export default { feature: "${feature}", scenarios: [{ name, run(ctx) }] }`
      );
    }

    suites.push(suite);
  }

  const unknown = [...(wanted ?? [])].filter(
    (name) => !suites.some((suite) => suite.feature === name)
  );

  if (unknown.length > 0) {
    throw new Error(
      `WB_E2E_NEXT_FEATURES names features without scenarios: ${unknown.map((name) => `"${name}"`).join(", ")}`
    );
  }

  if (suites.length === 0) {
    throw new Error("No feature scenarios found (src/next/features/<feature>/<feature>.e2e.mjs)");
  }

  return suites;
}

/** Marker in a page URL that makes `enableStrictStyleCsp` rewrite the page's policy. */
export const STRICT_CSP_QUERY = "&csp=strict";

/**
 * Serves pages whose URL carries `csp=strict` with the Player CSP minus `style-src
 * 'unsafe-inline'` (rewritten in flight with the Fetch domain; the build is not touched), so any
 * runtime-injected `<style>` shows up as a violation before R5 tightens the real policy.
 */
export async function enableStrictStyleCsp(client) {
  client.on("Fetch.requestPaused", (params) => {
    void rewritePolicy(client, params);
  });
  await client.send("Fetch.enable", {
    patterns: [{ urlPattern: "*csp=strict*", resourceType: "Document", requestStage: "Response" }]
  });
}

/** `'report-sample'` allows nothing; it makes the violation report carry the blocked text. */
function withReportSample(policy) {
  return serializeCsp(
    parseCsp(policy).map(([name, sources]) =>
      name === "style-src" ? [name, [...sources, "'report-sample'"]] : [name, sources]
    )
  );
}

async function rewritePolicy(client, params) {
  try {
    const { body, base64Encoded } = await client.send("Fetch.getResponseBody", {
      requestId: params.requestId
    });
    const html = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
    const strict = withCsp(html, withReportSample(strictStyleCsp(readCsp(html))));
    await client.send("Fetch.fulfillRequest", {
      requestId: params.requestId,
      responseCode: params.responseStatusCode ?? 200,
      responseHeaders: (params.responseHeaders ?? []).filter(
        (header) => header.name.toLowerCase() !== "content-length"
      ),
      body: Buffer.from(strict, "utf8").toString("base64")
    });
  } catch (error) {
    console.error("Strict CSP rewrite failed:", error instanceof Error ? error.message : error);
    await client.send("Fetch.continueRequest", { requestId: params.requestId }).catch(() => {});
  }
}
