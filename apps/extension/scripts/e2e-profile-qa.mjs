#!/usr/bin/env node

// E2E: a site rule picks the QA profile on a matching host and the exported archive contains
// console text and JSON response bodies; navigating to a host without a rule switches back to the
// Default profile mid-session (console text hidden again); exporting without a passphrase is refused
// (every archive is encrypted).

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assert, createProfileE2eHarness, sleep, waitFor } from "./lib/profile-e2e-harness.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(root, "..");
const repoRoot = resolve(appRoot, "..", "..");
const harness = createProfileE2eHarness({ name: "profile-qa", appRoot, defaultPort: "9231" });
const passphrase = "webblackbox-qa-e2e-passphrase";

const CONSOLE_MARKER = "qa-console-marker-7f3a";
const DEFAULT_CONSOLE_MARKER = "default-console-marker-c41d";
const BODY_MARKER = "qa-body-marker-91c2";
// A JWT-shaped value: the privacy scanner reports it (never blocking).
const SCANNER_FINDING =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJxYS1lMmUifQ.c2lnbmF0dXJlLWZvci1xYS1lMmUtdGVzdA";
const QA_RULE = {
  id: "e2e-local-qa",
  name: "Local QA",
  profileId: "builtin:qa",
  priority: 10,
  enabled: true,
  match: { hosts: ["127.0.0.1:*"] }
};

main().catch(async (error) => {
  console.error("Profile QA E2E failed:", error instanceof Error ? error.message : String(error));
  await harness.cleanup();
  process.exit(1);
});

async function main() {
  const { WebBlackboxPlayer } = await import(
    pathToFileURL(resolve(repoRoot, "packages/player-sdk/dist/index.js")).href
  );
  const appPort = await startDemoServer();
  const pageUrl = `http://127.0.0.1:${appPort}/qa/`;
  const { page, popup, swExceptions, dialogs } = await harness.launch(pageUrl);

  await popup.evaluate(`
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

  const tabId = await popup.evaluate(`
    chrome.tabs.query({}).then((tabs) =>
      tabs.find((tab) => tab.url?.startsWith(${JSON.stringify(pageUrl)}))?.id ?? null
    )
  `);
  assert(typeof tabId === "number", "QA page tab not found", { tabId });

  const preview = await popup.evaluate(
    `chrome.runtime.sendMessage({ kind: "ui.resolve-profile", tabId: ${tabId} })`
  );
  assert(
    preview?.selection?.id === "builtin:qa" && preview.selection.source === "rule",
    "Rule did not select the QA profile",
    preview
  );

  await popup.evaluate(
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
  await sleep(1_500);

  const pageResult = await page.evaluate(
    `window.__runQaScenario(${JSON.stringify(CONSOLE_MARKER)})`
  );
  assert(pageResult?.marker === BODY_MARKER, "Demo request failed", pageResult);
  await sleep(2_500);

  // Same tab, host without a rule: the session must switch to the Default profile.
  const defaultUrl = `http://localhost:${appPort}/qa/`;
  await page.send("Page.navigate", { url: defaultUrl });
  await waitFor(
    () =>
      page.evaluate(
        `(location.hostname === "localhost" && document.readyState === "complete" && typeof window.__runQaScenario === "function") || null`
      ),
    15_000,
    "Navigation to the rule-free host did not finish"
  );
  await sleep(2_500);
  await page.evaluate(`window.__runQaScenario(${JSON.stringify(DEFAULT_CONSOLE_MARKER)})`);
  await sleep(2_000);

  const sid = await popup.evaluate(`
    chrome.storage.local.get("webblackbox.runtime.sessions").then(
      (store) => store["webblackbox.runtime.sessions"]?.[0]?.sid ?? null
    )
  `);
  assert(typeof sid === "string", "Active session not found", { sid });

  const plaintext = await popup.evaluate(
    `chrome.runtime.sendMessage({ kind: "ui.export", sid: ${JSON.stringify(sid)}, saveAs: false })`
  );
  assert(
    plaintext?.ok === false && /always encrypted/i.test(plaintext.error ?? ""),
    "Plaintext export was not refused",
    plaintext
  );

  const exported = await popup.evaluate(`
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
  const manifestText = JSON.stringify(player.archive.manifest);
  const profileConfig = events.find(
    (event) => event.type === "meta.config" && event.data?.profile?.id === "builtin:qa"
  );
  // Leaving the rule's host first drops QA at once (no page probe), then the rules pick Default.
  const gateConfig = events.find(
    (event) =>
      event.type === "meta.config" &&
      event.data?.profileChange?.previous?.id === "builtin:qa" &&
      event.data?.profile?.downgradedFrom?.id === "builtin:qa"
  );
  const switchConfig = events.find(
    (event) =>
      event.type === "meta.config" &&
      event.data?.profile?.id === "default" &&
      // Re-evaluations collapse: the navigation or the later page-load request may land it.
      ["navigation", "page-loaded"].includes(event.data?.profileChange?.reason)
  );
  const leakedDefaultConsole = events.some(
    (event) =>
      event.type === "console.entry" && JSON.stringify(event.data).includes(DEFAULT_CONSOLE_MARKER)
  );
  const consoleEvent = events.find(
    (event) => event.type === "console.entry" && JSON.stringify(event.data).includes(CONSOLE_MARKER)
  );
  const bodyEvents = events.filter((event) => event.type === "network.body");
  const bodyTexts = await Promise.all(
    bodyEvents.map(async (event) => {
      const blob = await player.getBlob(event.data?.contentHash ?? "");
      return blob ? new TextDecoder().decode(blob.bytes) : "";
    })
  );
  const jsonBody = bodyTexts.find((text) => text.includes(BODY_MARKER));
  // QA keeps the DOM at the Full level: no page HTML (raw DOM blob) is recorded.
  const rawDomSnapshots = events.filter(
    (event) => event.type === "dom.snapshot" && event.data?.source === "html"
  );

  assert(profileConfig, "meta.config does not record the QA profile");
  assert(profileConfig.data.profile.ruleId === QA_RULE.id, "meta.config misses the rule", {
    profile: profileConfig.data.profile
  });
  assert(gateConfig, "QA was not dropped as soon as the tab left the rule's host", {
    profiles: events
      .filter((event) => event.type === "meta.config")
      .map((event) => event.data?.profile)
  });
  assert(switchConfig, "No meta.config for the switch back to the Default profile", {
    profiles: events
      .filter((event) => event.type === "meta.config")
      .map((event) => event.data?.profile)
  });
  assert(!leakedDefaultConsole, "Console text recorded after switching to the Default profile");
  assert(consoleEvent, "Console text missing from the QA archive", {
    types: [...new Set(events.map((event) => event.type))]
  });
  assert(jsonBody, "JSON response body missing from the QA archive", {
    bodies: bodyEvents.length
  });
  assert(!jsonBody.includes("hunter2"), "Sensitive body value was not masked", { jsonBody });
  assert(rawDomSnapshots.length === 0, "QA recorded the raw DOM", {
    snapshots: rawDomSnapshots.length
  });
  assert(!manifestText.includes("alice@example.com"), "Page title leaked into the manifest");
  assert(swExceptions.length === 0, "Service worker threw", swExceptions);
  assert(
    exported.privacyWarning?.findingCount > 0,
    "Export did not report the planted scanner finding",
    exported
  );

  console.log(`Archive: ${archivePath} (${bytes.byteLength} bytes)`);
  console.log(`Profile: ${JSON.stringify(profileConfig.data.profile)}`);
  console.log(`Console event: ${JSON.stringify(consoleEvent.data).slice(0, 200)}`);
  console.log(`Host gate: ${JSON.stringify(gateConfig.data.profile)}`);
  console.log(`Profile switch: ${JSON.stringify(switchConfig.data.profileChange)}`);
  console.log(`JSON body: ${jsonBody.slice(0, 200)}`);
  console.log(`Plaintext export refused: ${plaintext.error}`);
  console.log(`Dialogs accepted: ${JSON.stringify(dialogs)}`);
  console.log(`Chrome log: ${harness.chromeLogPath}`);
  console.log("Profile QA E2E passed.");

  await harness.cleanup();
}

function startDemoServer() {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>QA demo for alice@example.com</title></head>
<body><h1>QA demo</h1><input name="password" type="password">
<script>
  window.__runQaScenario = async (marker) => {
    console.log(marker, { orderId: 42 });
    const response = await fetch("/api/orders?env=qa", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: 42 })
    });
    return response.json();
  };
</script></body></html>`;
  const body = JSON.stringify({
    marker: BODY_MARKER,
    orders: [{ id: 42, status: "shipped" }],
    password: "hunter2",
    reference: SCANNER_FINDING
  });

  return new Promise((resolvePort, reject) => {
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/api/orders")) {
        request.resume();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(body);
        return;
      }

      if (request.url?.startsWith("/qa/")) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(html);
        return;
      }

      response.writeHead(404).end();
    });

    harness.trackServer(server);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePort(server.address().port));
  });
}
