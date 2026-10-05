#!/usr/bin/env node

// E2E: other tabs of the recorded site land in the archive. A same-origin tab open before Start
// is in the start snapshot; during the session a same-site tab (other port) is opened, navigated
// and closed, a second same-origin tab is opened and closed, the pre-existing tab navigates to
// another site and back, and a tab of another site
// (localhost vs 127.0.0.1) is opened and closed. The QA profile (picked by a site rule) records
// paths and titles; the other site never appears anywhere in the archive.

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assert, createProfileE2eHarness, sleep, waitFor } from "./lib/profile-e2e-harness.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(root, "..");
const repoRoot = resolve(appRoot, "..", "..");
const harness = createProfileE2eHarness({ name: "tabs-context", appRoot, defaultPort: "9237" });
const passphrase = "webblackbox-tabs-e2e-passphrase";

const FOREIGN_MARKER = "foreign-site-marker-5b7e";
const QA_RULE = {
  id: "e2e-local-qa",
  name: "Local QA",
  profileId: "builtin:qa",
  priority: 10,
  enabled: true,
  match: { hosts: ["127.0.0.1:*"] }
};
/** Longer than the tracker's 250 ms debounce, so every step lands as its own change. */
const STEP_MS = 900;

main().catch(async (error) => {
  console.error("Tabs context E2E failed:", error instanceof Error ? error.message : String(error));
  await harness.cleanup();
  process.exit(1);
});

async function main() {
  const { WebBlackboxPlayer, readTabsContext } = await import(
    pathToFileURL(resolve(repoRoot, "packages/player-sdk/dist/index.js")).href
  );
  const appPort = await startServer();
  const otherPort = await startServer();
  const pageUrl = `http://127.0.0.1:${appPort}/app/`;
  const { page, popup, swExceptions } = await harness.launch(pageUrl);
  const tabs = (expression) => popup.evaluate(expression);

  await tabs(`
    chrome.storage.local.set({
      "webblackbox.profiles": {
        schemaVersion: 2,
        defaultProfileId: "default",
        profiles: [],
        rules: [${JSON.stringify(QA_RULE)}],
        extendedCaptureHosts: []
      }
    }).then(() => true)
  `);

  const tabId = await tabs(`
    chrome.tabs.query({}).then((all) =>
      all.find((tab) => tab.url?.startsWith(${JSON.stringify(pageUrl)}))?.id ?? null
    )
  `);
  assert(typeof tabId === "number", "Recorded page tab not found", { tabId });

  // A same-origin tab that is already open when recording starts.
  const existingTabId = await createTab(tabs, `http://127.0.0.1:${appPort}/inbox/`);

  await tabs(
    `chrome.runtime.sendMessage({ kind: "ui.start", tabId: ${tabId}, mode: "full", visualCapture: "none" })`
  );
  await waitFor(
    () =>
      page.evaluate(
        `document.querySelector('[data-webblackbox-indicator="true"]')?.textContent?.includes("REC full") || null`
      ),
    25_000,
    "Recording indicator did not appear"
  );
  await sleep(STEP_MS);

  // Same site, other port: opened, navigated, closed while recording.
  const sameSiteTabId = await createTab(tabs, `http://127.0.0.1:${otherPort}/reports/`);
  await sleep(STEP_MS);
  await updateTab(tabs, sameSiteTabId, `http://127.0.0.1:${otherPort}/reports/weekly/`);
  await sleep(STEP_MS);

  // A third tab of the site, same origin as the recorded one.
  const sameOriginTabId = await createTab(tabs, `http://127.0.0.1:${appPort}/settings/`);
  await sleep(STEP_MS);

  // Another site: must never show up.
  const foreignTabId = await createTab(tabs, `http://localhost:${appPort}/${FOREIGN_MARKER}/`);
  await sleep(STEP_MS);

  // The pre-existing tab leaves the site and comes back.
  await updateTab(tabs, existingTabId, `http://localhost:${appPort}/${FOREIGN_MARKER}-away/`);
  await sleep(STEP_MS);
  await updateTab(tabs, existingTabId, `http://127.0.0.1:${appPort}/inbox/archived/`);
  await sleep(STEP_MS);

  await tabs(`chrome.tabs.remove(${sameSiteTabId}).then(() => true)`);
  await tabs(`chrome.tabs.remove(${sameOriginTabId}).then(() => true)`);
  await tabs(`chrome.tabs.remove(${foreignTabId}).then(() => true)`);
  await sleep(STEP_MS);

  const sid = await tabs(`
    chrome.storage.local.get("webblackbox.runtime.sessions").then(
      (store) => store["webblackbox.runtime.sessions"]?.[0]?.sid ?? null
    )
  `);
  assert(typeof sid === "string", "Active session not found", { sid });
  await tabs(`chrome.runtime.sendMessage({ kind: "ui.stop", tabId: ${tabId} })`);
  await sleep(1_000);

  const exported = await tabs(`
    chrome.runtime.sendMessage({
      kind: "ui.export",
      sid: ${JSON.stringify(sid)},
      passphrase: ${JSON.stringify(passphrase)},
      saveAs: false
    })
  `);
  assert(exported?.ok === true, "Encrypted export failed", exported);

  const archivePath = await harness.waitForDownload();
  const bytes = new Uint8Array(await readFile(archivePath));
  const player = await WebBlackboxPlayer.open(bytes, { passphrase });
  const events = player.query();
  const tabEvents = events.filter((event) => event.type.startsWith("meta.tabs."));
  const snapshot = tabEvents.find((event) => event.type === "meta.tabs.snapshot");
  const changes = tabEvents
    .filter((event) => event.type === "meta.tabs.change")
    .map((event) => ({
      change: event.data.change,
      tabId: event.data.tab.tabId,
      relation: event.data.tab.relation,
      path: event.data.tab.path
    }));
  const context = readTabsContext(events);
  const report = player.generateBugReport();
  const blocked = events.filter(
    (event) =>
      event.type === "privacy.violation" && String(event.data?.blockedType).startsWith("meta.tabs.")
  );

  assert(snapshot, "No meta.tabs.snapshot in the archive", {
    types: [...new Set(events.map((event) => event.type))]
  });
  assert(snapshot.data.level === "allow", "QA did not record the allow level", snapshot.data);
  assert(
    snapshot.data.tabs.length === 1 &&
      snapshot.data.tabs[0].tabId === existingTabId &&
      snapshot.data.tabs[0].relation === "same-origin" &&
      snapshot.data.tabs[0].path === "/inbox/",
    "Start snapshot does not hold exactly the pre-existing same-origin tab",
    snapshot.data
  );
  assert(
    !snapshot.data.tabs.some((tab) => tab.tabId === tabId),
    "The recorded tab is listed as another tab",
    snapshot.data
  );
  expectChange(changes, { change: "opened", tabId: sameSiteTabId, relation: "same-site" });
  expectChange(changes, {
    change: "navigated",
    tabId: sameSiteTabId,
    path: "/reports/weekly/"
  });
  expectChange(changes, { change: "closed", tabId: sameSiteTabId });
  expectChange(changes, {
    change: "opened",
    tabId: sameOriginTabId,
    relation: "same-origin",
    path: "/settings/"
  });
  expectChange(changes, { change: "closed", tabId: sameOriginTabId });
  expectChange(changes, { change: "left", tabId: existingTabId, path: "/inbox/" });
  expectChange(changes, { change: "entered", tabId: existingTabId, path: "/inbox/archived/" });
  assert(
    !changes.some((change) => change.tabId === foreignTabId),
    "A tab of another site was recorded",
    changes
  );
  assert(
    !JSON.stringify(events).includes(FOREIGN_MARKER),
    "The other site's URL leaked into the archive"
  );
  assert(blocked.length === 0, "Tab events were blocked by the profile", blocked);
  assert(
    context.summary.maxConcurrent >= 3 && context.summary.distinctTabs === 3,
    "player-sdk summary does not count the related tabs",
    context.summary
  );
  assert(/## Parallel Tabs/.test(report), "Bug report misses the parallel tabs section", {
    report: report.slice(0, 400)
  });
  assert(swExceptions.length === 0, "Service worker threw", swExceptions);

  console.log(`Archive: ${archivePath} (${bytes.byteLength} bytes)`);
  console.log(`Snapshot: ${JSON.stringify(snapshot.data)}`);
  console.log(`Changes: ${JSON.stringify(changes)}`);
  console.log(`Summary: ${JSON.stringify(context.summary)}`);
  console.log(`Chrome log: ${harness.chromeLogPath}`);
  console.log("Tabs context E2E passed.");

  await harness.cleanup();
}

function expectChange(changes, expected) {
  assert(
    changes.some((change) =>
      Object.entries(expected).every(([key, value]) => change[key] === value)
    ),
    `Missing tab change ${JSON.stringify(expected)}`,
    changes
  );
}

async function createTab(tabs, url) {
  const id = await tabs(
    `chrome.tabs.create({ url: ${JSON.stringify(url)}, active: false }).then((tab) => tab.id)`
  );
  assert(typeof id === "number", "Could not open a tab", { url, id });
  await waitForTabComplete(tabs, id);
  return id;
}

async function updateTab(tabs, id, url) {
  await tabs(`chrome.tabs.update(${id}, { url: ${JSON.stringify(url)} }).then(() => true)`);
  await waitForTabComplete(tabs, id, url);
}

function waitForTabComplete(tabs, id, url) {
  const expectedUrl = JSON.stringify(url ?? "");

  return waitFor(
    () =>
      tabs(`
        chrome.tabs.get(${id}).then((tab) =>
          tab.status === "complete" && (${expectedUrl} === "" || tab.url === ${expectedUrl})
        )
      `).then((done) => done || null),
    15_000,
    `Tab ${id} did not finish loading`
  );
}

function startServer() {
  return new Promise((resolvePort, reject) => {
    const server = createServer((request, response) => {
      const title = `Tabs E2E ${request.url ?? "/"}`;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
          `<body><h1>${title}</h1></body></html>`
      );
    });

    harness.trackServer(server);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePort(server.address().port));
  });
}
