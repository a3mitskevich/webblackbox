#!/usr/bin/env node

// E2E: "Start with page reload" in the Full engine. The page is already loaded when recording
// starts; the service worker starts the session (CDP attached and enabled) and only then reloads
// the tab, so the archive holds the page load from scratch: the document request, the first
// script and its console line, and the first request that script makes. The reload of the same
// URL keeps the recording going (no "profile changed" cancel) and the content script comes back.
// A Full start without the reload leaves the page alone. The Full capture profile is chosen so the
// archive keeps URLs and console text as they were (the Default profile masks both).

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assert, createProfileE2eHarness, sleep, waitFor } from "./lib/profile-e2e-harness.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(root, "..");
const repoRoot = resolve(appRoot, "..", "..");
const harness = createProfileE2eHarness({
  name: "full-start-reload",
  appRoot,
  defaultPort: "9236"
});
const passphrase = "webblackbox-full-reload-e2e";
const FULL_CAPTURE_ID = "builtin:full-capture";
const PAGE_PATH = "/reload/";
/** The page load number is in the paths, so each load's requests and console line are unique. */
const bootScriptPath = (load) => `/reload/boot-${load}.js`;
const firstRequestPath = (load) => `/reload/api/first-${load}`;
const bootConsoleText = (load) => `WB-RELOAD-BOOT-${load}`;
const INDICATOR_TIMEOUT_MS = 25_000;
const SETTLE_MS = 2_500;

const served = { documents: 0 };

main().catch(async (error) => {
  console.error(
    "Full start reload E2E failed:",
    error instanceof Error ? error.message : String(error)
  );
  await harness.cleanup();
  process.exit(1);
});

async function main() {
  const { WebBlackboxPlayer } = await import(
    pathToFileURL(resolve(repoRoot, "packages/player-sdk/dist/index.js")).href
  );
  const appPort = await startDemoServer();
  const pageUrl = `http://127.0.0.1:${appPort}${PAGE_PATH}`;
  const { page, popup, swExceptions } = await harness.launch(pageUrl);

  await waitFor(() => readPageLoad(page, 1), 15_000, "The page did not finish its first load");

  const tabId = await popup.evaluate(`
    chrome.tabs.query({}).then((tabs) =>
      tabs.find((tab) => tab.url?.startsWith(${JSON.stringify(pageUrl)}))?.id ?? null
    )
  `);
  assert(typeof tabId === "number", "Demo page tab not found", { tabId });

  // --- Full start with reload ----------------------------------------------------------------
  const started = await popup.evaluate(
    `chrome.runtime.sendMessage({ kind: "ui.start", tabId: ${tabId}, mode: "full", visualCapture: "none", profileId: ${JSON.stringify(FULL_CAPTURE_ID)}, reloadPage: true })`
  );
  assert(started?.ok !== false, "Full start with reload was rejected", started);

  await waitFor(() => readPageLoad(page, 2), 15_000, "The tab was not reloaded after Start");
  await waitForIndicator(page, "The recorder indicator did not come back after the reload");
  await sleep(SETTLE_MS);

  const sessions = await listSessions(popup);
  const session = sessions.find((entry) => entry.tabId === tabId && entry.active);
  assert(session, "The recording did not survive its own reload", sessions);
  assert(session.mode === "full", "The recording does not run in Full", session);
  assert(!session.profileCancel, "The reload cancelled the recording's profile", session);
  assert(served.documents === 2, "Start reloaded the page more than once", served);

  const stopped = await popup.evaluate(
    `chrome.runtime.sendMessage({ kind: "ui.stop", tabId: ${tabId} })`
  );
  assert(stopped?.ok !== false, "Stop failed", stopped);

  const exported = await popup.evaluate(`
    chrome.runtime.sendMessage({
      kind: "ui.export",
      sid: ${JSON.stringify(session.sid)},
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
  const types = [...new Set(events.map((event) => event.type))];
  const requests = events.filter((event) => event.type === "network.request");
  const requestTo = (path) =>
    requests.find((event) => {
      const url = event.data?.request?.url ?? event.data?.url;
      return typeof url === "string" && new URL(url).pathname === path;
    });
  const documentRequest = requestTo(PAGE_PATH);
  const bootRequest = requestTo(bootScriptPath(2));
  const firstRequest = requestTo(firstRequestPath(2));
  const bootConsole = events.find(
    (event) =>
      event.type === "console.entry" && JSON.stringify(event.data).includes(bootConsoleText(2))
  );

  assert(documentRequest, "The archive misses the reloaded document request", {
    types,
    urls: requests.map((event) => event.data?.request?.url ?? event.data?.url)
  });
  assert(
    documentRequest.data?.type === "Document",
    "The page request was not recorded as the document load",
    documentRequest.data
  );
  assert(bootRequest, "The archive misses the first script of the reloaded page", { types });
  assert(bootConsole, "The archive misses the first console line of the reloaded page", {
    types
  });
  assert(firstRequest, "The archive misses the first request of the reloaded page", { types });
  assert(
    documentRequest.mono <= bootRequest.mono && bootRequest.mono <= bootConsole.mono,
    "The page load was recorded out of order",
    { document: documentRequest.mono, boot: bootRequest.mono, console: bootConsole.mono }
  );

  // --- Full start without reload ---------------------------------------------------------------
  const startedDirect = await popup.evaluate(
    `chrome.runtime.sendMessage({ kind: "ui.start", tabId: ${tabId}, mode: "full", visualCapture: "none" })`
  );
  assert(startedDirect?.ok !== false, "Full start without reload was rejected", startedDirect);
  await waitForIndicator(page, "The recorder indicator did not appear for the direct start");
  await sleep(SETTLE_MS);
  assert(served.documents === 2, "A Full start without reload reloaded the page", served);
  await popup.evaluate(`chrome.runtime.sendMessage({ kind: "ui.stop", tabId: ${tabId} })`);

  assert(swExceptions.length === 0, "Service worker threw", swExceptions);

  console.log(`Archive: ${archivePath} (${events.length} events)`);
  console.log(
    `Recorded from the reload: document ${PAGE_PATH}, script ${bootScriptPath(2)}, console "${bootConsoleText(2)}", request ${firstRequestPath(2)}`
  );
  console.log(`Chrome log: ${harness.chromeLogPath}`);
  console.log("Full start reload E2E passed.");

  await harness.cleanup();
}

/** The page's load number once that load finished, else null. */
function readPageLoad(page, load) {
  return page
    .evaluate(
      `(document.readyState === "complete" && window.__wbLoad === ${load} && window.__wbFirstDone === true) || null`
    )
    .catch(() => null);
}

function waitForIndicator(page, message) {
  return waitFor(
    () =>
      page
        .evaluate(
          `document.querySelector('[data-webblackbox-indicator="true"]')?.textContent?.includes("REC full") || null`
        )
        .catch(() => null),
    INDICATOR_TIMEOUT_MS,
    message
  );
}

function listSessions(popup) {
  return popup.evaluate(
    `chrome.runtime.sendMessage({ kind: "ui.request-session-list" }).then((list) => list?.sessions ?? [])`
  );
}

function startDemoServer() {
  const pageHtml = (load) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Reload on start demo</title>
<script src="${bootScriptPath(load)}"></script></head>
<body><h1>Reload on start demo</h1><p>Load ${load}</p></body></html>`;
  const bootScript = (load) => `window.__wbLoad = ${load};
console.log(${JSON.stringify(bootConsoleText(load))});
fetch(${JSON.stringify(firstRequestPath(load))})
  .then((response) => response.text())
  .finally(() => {
    window.__wbFirstDone = true;
  });
`;
  const noStore = { "cache-control": "no-store" };

  return new Promise((resolvePort, reject) => {
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;

      if (path === PAGE_PATH) {
        served.documents += 1;
        response.writeHead(200, { ...noStore, "content-type": "text/html; charset=utf-8" });
        response.end(pageHtml(served.documents));
        return;
      }

      const boot = /^\/reload\/boot-(\d+)\.js$/.exec(path);

      if (boot) {
        response.writeHead(200, { ...noStore, "content-type": "text/javascript" });
        response.end(bootScript(Number(boot[1])));
        return;
      }

      if (path.startsWith("/reload/api/first-")) {
        response.writeHead(200, { ...noStore, "content-type": "text/plain" });
        response.end("ok");
        return;
      }

      response.writeHead(404).end();
    });

    harness.trackServer(server);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePort(server.address().port));
  });
}
