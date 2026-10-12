#!/usr/bin/env node

// Heavy-page bound of the accessibility snapshot: the page-side walk (bundled from
// packages/webblackbox/src/a11y-snapshot.ts) runs in real Chrome on very large and very deep
// pages, scrolled and not, and must stay within its time, node and size budgets.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "tsup";

import { CdpClient } from "./lib/cdp-client.mjs";
import {
  reserveEphemeralPort,
  resolveChromeBinary,
  terminateChromeProcess,
  waitForChromeReady
} from "./lib/chrome-launcher.mjs";
import { assert, fetchJson, sleep } from "./lib/e2e-utils.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, "..", "..", "..");
const walkerEntry = resolve(workspaceRoot, "packages/webblackbox/src/a11y-snapshot.ts");
const headless = (process.env.WB_E2E_HEADLESS ?? "1") === "1";
const runsPerPage = 5;
// The walk stops at 40 ms of page time; the rest is the layout flush and writing the text.
// Generous for shared CI runners: the point is a bound, not a benchmark.
const MAX_WALL_MS = Number(process.env.WB_E2E_A11Y_MAX_WALL_MS ?? 250);
const MAX_TREE_CHARS = 24_000 + 256;
const MAX_NODES = 800;

const PAGES = [
  { name: "rows-15k", rows: 3_000 },
  { name: "rows-100k", rows: 20_000 },
  { name: "rows-100k-scrolled", rows: 20_000, scrollTo: 0.5 },
  { name: "nested-5k", nested: 5_000 }
];

async function main() {
  const workDir = await mkdtemp(join(tmpdir(), "wb-a11y-heavy-"));
  let chrome = null;
  let server = null;
  let client = null;

  try {
    const walker = await bundleWalker(workDir);
    server = await startServer(walker);
    const binary = await resolveChromeBinary();
    const port = await reserveEphemeralPort();
    chrome = spawn(
      binary,
      [
        ...(headless ? ["--headless=new"] : []),
        ...(process.platform === "linux" ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${join(workDir, "profile")}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1280,800",
        "about:blank"
      ],
      { stdio: "ignore" }
    );
    await waitForChromeReady(`http://127.0.0.1:${port}`, 20_000, { proc: chrome });
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, 5_000);
    const page = targets.find((target) => target.type === "page");
    assert(page?.webSocketDebuggerUrl, "No page target", { targets });
    client = new CdpClient(page.webSocketDebuggerUrl, { commandTimeoutMs: 60_000 });
    await client.connect();
    await client.send("Page.enable");

    const results = [];

    for (const spec of PAGES) {
      results.push(await measurePage(client, server.url, spec));
    }

    console.log("Accessibility snapshot on heavy pages:");

    for (const result of results) {
      console.log(`  ${JSON.stringify(result)}`);
    }

    const failures = results.filter((result) => !result.ok);
    assert(failures.length === 0, "Accessibility snapshot exceeded its bounds", { failures });
    console.log("Accessibility heavy-page check passed.");
  } finally {
    client?.close();
    await terminateChromeProcess(chrome);
    await new Promise((resolveClose) => (server ? server.close(resolveClose) : resolveClose()));
    await rm(workDir, { recursive: true, force: true });
  }
}

async function measurePage(client, baseUrl, spec) {
  const query = new URLSearchParams({
    rows: String(spec.rows ?? 0),
    nested: String(spec.nested ?? 0)
  });
  await client.send("Page.navigate", { url: `${baseUrl}/page?${query}` });
  await waitForPage(client);

  const elements = await client.evaluate(`document.getElementsByTagName("*").length`);

  if (spec.scrollTo) {
    await client.evaluate(
      `window.scrollTo(0, document.documentElement.scrollHeight * ${spec.scrollTo}); true`
    );
    await sleep(200);
  }

  const runs = [];

  for (let index = 0; index < runsPerPage; index += 1) {
    runs.push(
      await client.evaluate(`
        (() => {
          const startedAt = performance.now();
          const snapshot = window.WbA11y.captureA11ySnapshot({
            policy: window.WB_POLICY,
            trigger: { kind: "action", rawType: "click" }
          });
          return {
            wallMs: performance.now() - startedAt,
            durationMs: snapshot.durationMs,
            nodeCount: snapshot.nodeCount,
            omittedNodes: snapshot.omittedNodes,
            treeChars: snapshot.tree.length,
            firstLine: snapshot.tree.split("\\n")[0]
          };
        })()
      `)
    );
    await sleep(50);
  }

  const maxWallMs = Math.max(...runs.map((run) => run.wallMs));
  const last = runs[runs.length - 1];

  return {
    ok:
      maxWallMs <= MAX_WALL_MS &&
      runs.every((run) => run.treeChars <= MAX_TREE_CHARS && run.nodeCount <= MAX_NODES),
    page: spec.name,
    elements,
    maxWallMs: Math.round(maxWallMs * 10) / 10,
    medianWallMs: Math.round(median(runs.map((run) => run.wallMs)) * 10) / 10,
    maxDurationMs: Math.max(...runs.map((run) => run.durationMs)),
    nodeCount: last.nodeCount,
    omittedNodes: last.omittedNodes,
    treeChars: last.treeChars,
    firstLine: last.firstLine
  };
}

async function waitForPage(client) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const ready = await client
      .evaluate(`document.readyState === "complete" && Boolean(window.WbA11y && window.WB_READY)`)
      .catch(() => false);

    if (ready) {
      return;
    }

    await sleep(100);
  }

  throw new Error("Heavy page did not load");
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** The page walker as an IIFE (`window.WbA11y`), from source like the extension bundles it. */
async function bundleWalker(workDir) {
  const outDir = join(workDir, "bundle");
  await build({
    entry: { walker: walkerEntry },
    format: ["iife"],
    globalName: "WbA11y",
    platform: "browser",
    target: "es2022",
    outDir,
    bundle: true,
    noExternal: [/.*/],
    minify: true,
    silent: true,
    dts: false,
    sourcemap: false,
    splitting: false,
    clean: true,
    config: false
  });
  return readFile(join(outDir, "walker.global.js"), "utf8");
}

function startServer(walker) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/walker.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(walker);
      return;
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      heavyPageHtml(Number(url.searchParams.get("rows")), Number(url.searchParams.get("nested")))
    );
  });

  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.url = `http://127.0.0.1:${address.port}`;
      resolveServer(server);
    });
  });
}

function heavyPageHtml(rows, nested) {
  return `<!doctype html>
<html><head><title>Heavy page</title>
<script src="/walker.js"></script>
</head><body>
<header><nav><a href="#a">Home</a> <a href="#b">Docs</a></nav></header>
<main>
  <h1>Heavy page</h1>
  <form aria-label="Pay"><label>Email <input type="email" required></label>
  <button disabled>Pay</button></form>
  <div id="root"></div>
</main>
<script>
  window.WB_POLICY = {
    schemaVersion: 2, mode: "private", captureContext: "real-user",
    consent: { id: "e2e", provenance: "self-recording", purpose: "debugging", grantedAt: "1970-01-01T00:00:00.000Z" },
    unmaskPolicySource: "none",
    scope: { tabId: 0, origin: "", allowedOrigins: [], deniedOrigins: [], includeSubframes: false, stopOnOriginChange: true, excludedUrlPatterns: [] },
    categories: { actions: "metadata", inputs: "length-only", dom: "masked", screenshots: "off", screenRecordings: "off", console: "metadata", network: "metadata", storage: "counts-only", indexedDb: "counts-only", cookies: "count-only", cdp: "off", heapProfiles: "off" },
    redaction: { redactHeaders: [], redactCookieNames: [], redactBodyPatterns: ["password", "token"], blockedSelectors: [".secret", "[data-sensitive]", "input[type='password']"], hashSensitiveValues: true },
    encryption: { localAtRest: "required", archive: "required", archiveKeyEnvelope: "passphrase" },
    retention: { localTtlMs: 86400000 }
  };
  const root = document.getElementById("root");
  const parts = [];
  for (let index = 0; index < ${rows}; index += 1) {
    parts.push('<div class="row"><span>Row ' + index + '</span> <a href="#r' + index + '">open ' + index + '</a> <button>Act ' + index + '</button><input type="checkbox"' + (index % 2 ? " checked" : "") + '></div>');
  }
  let deep = "<button>Deep</button>";
  for (let index = 0; index < ${nested}; index += 1) {
    deep = "<div>" + deep + "</div>";
  }
  root.innerHTML = parts.join("") + (${nested} > 0 ? deep : "");
  window.WB_READY = true;
</script>
</body></html>`;
}

main().catch((error) => {
  console.error(
    "Accessibility heavy-page check failed:",
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
});
