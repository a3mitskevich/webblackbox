#!/usr/bin/env node

// E2E: a site rule picks the QA profile on a matching host and the exported archive contains
// console text and JSON response bodies. The rule also reads the DOM: a navigation on the same
// host to a page that is slow to load keeps recording (the check waits for the loaded page).
// Navigating to a host where the rules pick another profile (Default) stops the recording: the
// archive records why, the badge shows "!", the popup explains it, and nothing after the change is
// recorded. Exporting without a passphrase is refused (every archive is encrypted). A second
// recording is stopped as soon as its profile is deleted, without any navigation.

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
  match: { hosts: ["127.0.0.1:*"], selectorPresent: "#qa-app" }
};
/** The `?slow=1` page sends `#qa-app` only after this delay (longer than the page probe). */
const SLOW_PAGE_DELAY_MS = 2_500;

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

  const listSessions = () =>
    popup.evaluate(
      `chrome.runtime.sendMessage({ kind: "ui.request-session-list" }).then((list) => list?.sessions ?? [])`
    );
  const sid = (await listSessions()).find((session) => session.active)?.sid;
  assert(typeof sid === "string", "Active session not found", { sid });

  // Same host, a page whose DOM arrives late: the rule cannot match before the page has loaded,
  // and the recording must go on instead of being cancelled on the half-loaded page.
  await page.send("Page.navigate", { url: `${pageUrl}?slow=1` });
  await waitFor(
    () =>
      page.evaluate(
        `(location.search === "?slow=1" && document.readyState === "complete" && typeof window.__runQaScenario === "function") || null`
      ),
    15_000,
    "Navigation to the slow page did not finish"
  );
  await sleep(2_500);
  const afterSlowPage = (await listSessions()).find((session) => session.sid === sid);
  assert(
    afterSlowPage?.active === true && !afterSlowPage.profileCancel,
    "The recording was cancelled while a same-host page was loading",
    afterSlowPage
  );

  // Same tab, host without a rule: the rules now pick Default, so the recording is cancelled.
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
  const cancelled = await waitFor(
    async () =>
      (await listSessions()).find(
        (session) => session.sid === sid && !session.active && session.profileCancel
      ) ?? null,
    15_000,
    "The recording was not cancelled after the profile changed"
  );
  assert(
    cancelled.profileCancel.reason === "rule-changed" &&
      cancelled.profileCancel.startedName === "QA" &&
      cancelled.profileCancel.nextName === "Default",
    "Unexpected cancellation notice",
    cancelled.profileCancel
  );
  const badge = await popup.evaluate(`chrome.action.getBadgeText({})`);
  assert(badge === "!", "The badge does not flag the cancelled recording", { badge });

  // The popup explains what changed and how to fix it.
  await popup.send("Page.reload", {});
  const noticeText = await waitFor(
    () => popup.evaluate(`document.querySelector("[data-profile-cancel]")?.textContent ?? null`),
    10_000,
    "The popup does not show the cancellation notice"
  );
  assert(
    noticeText.includes("Recording stopped: the profile changed") &&
      noticeText.includes("site rules pick Default") &&
      noticeText.includes("add a site rule"),
    "The popup notice does not explain the change",
    { noticeText }
  );

  // Dismissing the notice clears the badge.
  await popup.evaluate(
    `document.querySelector("[data-action='ack-profile-cancel']")?.click() ?? true`
  );
  await waitFor(
    async () => ((await popup.evaluate(`chrome.action.getBadgeText({})`)) === "" ? true : null),
    10_000,
    "Dismissing the notice did not clear the badge"
  );

  await page.evaluate(`window.__runQaScenario(${JSON.stringify(DEFAULT_CONSOLE_MARKER)})`);
  await sleep(2_000);

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
  const cancelConfig = events.find(
    (event) => event.type === "meta.config" && event.data?.profileCancel
  );
  const switchedConfig = events.find(
    (event) => event.type === "meta.config" && event.data?.profile?.id !== "builtin:qa"
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
  assert(
    cancelConfig?.data.profileCancel.reason === "rule-changed" &&
      cancelConfig.data.profileCancel.started?.id === "builtin:qa" &&
      cancelConfig.data.profileCancel.next?.id === "default" &&
      // Re-evaluations collapse: the navigation or the later page-load request may land it.
      ["navigation", "page-loaded"].includes(cancelConfig.data.profileCancel.trigger),
    "The archive does not record why the recording was cancelled",
    { profileCancel: cancelConfig?.data.profileCancel }
  );
  assert(!switchedConfig, "The recording switched profiles instead of stopping", {
    profile: switchedConfig?.data.profile
  });
  assert(!leakedDefaultConsole, "Console text recorded after the recording was cancelled");
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
  console.log(`Cancellation: ${JSON.stringify(cancelConfig.data.profileCancel)}`);
  console.log(`Popup notice: ${noticeText}`);
  console.log(`JSON body: ${jsonBody.slice(0, 200)}`);
  console.log(`Plaintext export refused: ${plaintext.error}`);
  console.log(`Dialogs accepted: ${JSON.stringify(dialogs)}`);

  await assertCancelOnProfileDeletion({ popup, tabId, listSessions });

  console.log(`Chrome log: ${harness.chromeLogPath}`);
  console.log("Profile QA E2E passed.");

  await harness.cleanup();
}

/** A recording whose profile is deleted in storage stops at once, with no navigation. */
async function assertCancelOnProfileDeletion({ popup, tabId, listSessions }) {
  await popup.evaluate(
    `chrome.runtime.sendMessage({ kind: "ui.start", tabId: ${tabId}, mode: "full", visualCapture: "none", profileId: "builtin:qa" })`
  );
  const session = await waitFor(
    async () => (await listSessions()).find((entry) => entry.active) ?? null,
    25_000,
    "The second recording did not start"
  );
  assert(session.profileName === "QA", "The second recording does not use QA", session);
  await sleep(1_500);

  await popup.evaluate(`
    chrome.storage.local.set({
      "webblackbox.profiles": {
        schemaVersion: 2,
        defaultProfileId: "default",
        profiles: [],
        rules: [${JSON.stringify(QA_RULE)}],
        extendedCaptureHosts: [],
        removedRecommendedProfileIds: ["builtin:qa"]
      }
    }).then(() => true)
  `);
  const cancelled = await waitFor(
    async () =>
      (await listSessions()).find(
        (entry) => entry.sid === session.sid && !entry.active && entry.profileCancel
      ) ?? null,
    10_000,
    "Deleting the recording's profile did not stop it"
  );
  assert(
    cancelled.profileCancel.reason === "profile-missing" &&
      cancelled.profileCancel.startedName === "QA",
    "Unexpected notice after deleting the profile",
    cancelled.profileCancel
  );
  console.log(`Deleted profile: ${JSON.stringify(cancelled.profileCancel)}`);
}

function startDemoServer() {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>QA demo for alice@example.com</title></head>
<body><h1>QA demo</h1><div id="qa-app"></div><input name="password" type="password">
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

      if (request.url?.startsWith("/qa/?slow=1")) {
        // The head (and title) arrive at once, the body with `#qa-app` only after the delay.
        const split = html.indexOf("<body>");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.write(html.slice(0, split));
        const timer = setTimeout(() => response.end(html.slice(split)), SLOW_PAGE_DELAY_MS);
        response.on("close", () => clearTimeout(timer));
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
