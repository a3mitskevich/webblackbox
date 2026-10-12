#!/usr/bin/env node

// E2E: Full → Light fallback. A fresh install records with Maximum (Full). Mid-recording the tab
// goes to a page Chrome never lets an extension debug (chrome://version), which detaches the
// debugger while the tab stays: the recording goes on in Light instead of ending (LITE badge,
// `captureFallback` on the session). Back on the site, page-side capture and the browser-side
// network baseline still record. The exported archive says when and why Full stopped (a
// `sys.debugger.detach` event, `meta.config.captureFallback`, the completeness report) and keeps
// what Full recorded before (the first response body).

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assert, createProfileE2eHarness, sleep, waitFor } from "./lib/profile-e2e-harness.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(root, "..");
const repoRoot = resolve(appRoot, "..", "..");
const harness = createProfileE2eHarness({ name: "capture-fallback", defaultPort: "9241" });
const passphrase = "webblackbox-fallback-e2e";
const BEFORE_MARKER = "before-fallback-body-3c1d";
const AFTER_MARKER = "after-fallback-body-8e2a";
const FALLBACK_REASONS = ["target-closed", "detached"];

main().catch(async (error) => {
  console.error(
    "Capture fallback E2E failed:",
    error instanceof Error ? error.message : String(error)
  );
  await harness.cleanup();
  process.exit(1);
});

async function main() {
  const { WebBlackboxPlayer } = await import(
    pathToFileURL(resolve(repoRoot, "packages/player-sdk/dist/index.js")).href
  );
  const appPort = await startServer();
  const pageUrl = `http://127.0.0.1:${appPort}/app/`;
  const { page, popup, swExceptions } = await harness.launch(pageUrl);
  const listSessions = () =>
    popup.evaluate(
      `chrome.runtime.sendMessage({ kind: "ui.request-session-list" }).then((list) => list?.sessions ?? [])`
    );
  const tabId = await popup.evaluate(`
    chrome.tabs.query({}).then((tabs) =>
      tabs.find((tab) => tab.url?.startsWith(${JSON.stringify(pageUrl)}))?.id ?? null
    )
  `);
  assert(typeof tabId === "number", "Page tab not found", { tabId });

  // As the popup's Record button sends it: Maximum, the default, starts in Full.
  await popup.evaluate(`chrome.runtime.sendMessage({ kind: "ui.start", tabId: ${tabId} })`);
  const started = await waitFor(
    async () => (await listSessions()).find((session) => session.active) ?? null,
    25_000,
    "The recording did not start"
  );
  assert(
    started.mode === "full" && !started.captureFallback,
    "Maximum did not start in Full",
    started
  );
  await sleep(1_500);
  await page.evaluate(`window.__load("/api/before")`);
  await sleep(1_500);

  // A page the debugger may not stay on: Chrome detaches it, the tab stays.
  await page.send("Page.navigate", { url: "chrome://version" });
  const fallen = await waitFor(
    async () =>
      (await listSessions()).find(
        (session) => session.sid === started.sid && session.active && session.captureFallback
      ) ?? null,
    20_000,
    "The recording did not fall back to Light when the debugger left"
  );
  assert(
    fallen.mode === "lite" && FALLBACK_REASONS.includes(fallen.captureFallback.reason),
    "Unexpected fallback record",
    fallen
  );
  const badge = await popup.evaluate(`chrome.action.getBadgeText({})`);
  assert(badge === "LITE", "The badge does not show the Light fallback", { badge });

  // Back on the site: the recording goes on with page-side capture.
  await page.send("Page.navigate", { url: pageUrl });
  await waitFor(
    () =>
      page.evaluate(
        `(document.readyState === "complete" && typeof window.__load === "function") || null`
      ),
    15_000,
    "The page did not load again"
  );
  await sleep(1_500);
  await page.evaluate(`window.__load("/api/after")`);
  await sleep(2_500);

  await popup.evaluate(`chrome.runtime.sendMessage({ kind: "ui.stop", tabId: ${tabId} })`);
  await waitFor(
    async () =>
      (await listSessions()).find((session) => session.sid === started.sid && !session.active) ??
      null,
    20_000,
    "The recording did not stop"
  );
  const exported = await popup.evaluate(`
    chrome.runtime.sendMessage({
      kind: "ui.export",
      sid: ${JSON.stringify(started.sid)},
      passphrase: ${JSON.stringify(passphrase)},
      saveAs: false
    })
  `);
  assert(exported?.ok === true, "Export failed", exported);

  const archivePath = await harness.waitForDownload();
  const player = await WebBlackboxPlayer.open(new Uint8Array(await readFile(archivePath)), {
    passphrase
  });
  const events = player.query();
  const completeness = player.getCaptureCompleteness();
  const detach = events.find((event) => event.type === "sys.debugger.detach");
  const fallbackConfig = events.find(
    (event) => event.type === "meta.config" && event.data?.captureFallback
  );
  const requests = player.getNetworkWaterfall();
  const before = requests.find((entry) => entry.url.includes("/api/before"));
  const after = requests.find((entry) => entry.url.includes("/api/after"));
  const bodies = events
    .filter((event) => event.type === "network.body")
    .map((event) => JSON.stringify(event.data));

  assert(detach, "The archive has no debugger detach event");
  assert(
    fallbackConfig?.data.mode === "lite" &&
      fallbackConfig.data.profile?.id === "builtin:maximum" &&
      FALLBACK_REASONS.includes(fallbackConfig.data.captureFallback.reason),
    "The archive does not record the switch to Light",
    fallbackConfig?.data.captureFallback
  );
  assert(
    completeness.captureFallback?.from === "full" && completeness.captureFallback.to === "lite",
    "The completeness report does not show the fallback",
    completeness.captureFallback
  );
  assert(before, "The request made in Full is missing", { urls: requests.map((r) => r.url) });
  assert(
    bodies.some((body) => body.includes(BEFORE_MARKER)) || Boolean(before.responseBodyHash),
    "The response body recorded in Full is missing"
  );
  assert(after, "The request made after the fallback is missing", {
    urls: requests.map((r) => r.url)
  });
  assert(swExceptions.length === 0, "Service worker threw", swExceptions);

  console.log(`Fallback: ${JSON.stringify(fallen.captureFallback)}`);
  console.log(`Archive: ${archivePath}`);
  console.log("Capture fallback E2E passed.");
  await harness.cleanup();
}

function startServer() {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Fallback demo</title></head>
<body><h1>Fallback demo</h1>
<script>
  window.__load = async (path) => {
    const response = await fetch(path, { cache: "no-store" });
    const json = await response.json();
    console.log("loaded", path, json.marker);
    return json.marker;
  };
</script></body></html>`;
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/api/")) {
      const marker = request.url.includes("before") ? BEFORE_MARKER : AFTER_MARKER;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ marker }));
      return;
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  harness.trackServer(server);

  return new Promise((resolvePort) => {
    server.listen(0, "127.0.0.1", () => resolvePort(server.address().port));
  });
}
