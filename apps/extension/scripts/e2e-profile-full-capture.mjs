#!/usr/bin/env node

// E2E: a site rule picks the Full capture preset, which records content as captured (no masking).
// Planted fake secrets (console text, storage value, URL token, Authorization header, request and
// response bodies, password field) must be present raw in the decrypted archive. After the tab
// moves to a host without a rule, the Default profile masks again and the same kind of secrets
// must be absent. The archive itself is always encrypted: none of the secrets, nor the site,
// appear in its raw bytes, and an export without a passphrase is refused.

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assert, createProfileE2eHarness, sleep, waitFor } from "./lib/profile-e2e-harness.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(root, "..");
const repoRoot = resolve(appRoot, "..", "..");
const harness = createProfileE2eHarness({
  name: "profile-full-capture",
  appRoot,
  defaultPort: "9232"
});
const passphrase = "webblackbox-full-capture-e2e";

/** Secrets planted under Full capture: each must be in the archive as captured. */
const RAW_SECRETS = {
  console: "FC-CONSOLE-SECRET-1",
  storage: "FC-STORAGE-SECRET-1",
  url: "FC-URL-TOKEN-1",
  header: "FC-HEADER-SECRET-1",
  requestBody: "FC-REQUEST-BODY-1",
  responseBody: "FC-RESPONSE-BODY-1",
  password: "FC-PASSWORD-1"
};
/** The same kinds of secrets planted after the switch to Default: none may be recorded. */
const DEFAULT_SECRETS = {
  console: "DF-CONSOLE-SECRET-2",
  storage: "DF-STORAGE-SECRET-2",
  url: "DF-URL-TOKEN-2",
  header: "DF-HEADER-SECRET-2",
  requestBody: "DF-REQUEST-BODY-2",
  responseBody: "DF-RESPONSE-BODY-2",
  password: "DF-PASSWORD-2"
};
const FULL_CAPTURE_RULE = {
  id: "e2e-local-full-capture",
  name: "Local full capture",
  profileId: "builtin:full-capture",
  priority: 10,
  enabled: true,
  match: { hosts: ["127.0.0.1:*"] }
};

main().catch(async (error) => {
  console.error(
    "Profile full capture E2E failed:",
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
  const pageUrl = `http://127.0.0.1:${appPort}/fc/`;
  const { page, popup, swExceptions } = await harness.launch(pageUrl);

  await popup.evaluate(`
    chrome.storage.local.set({
      "webblackbox.profiles": {
        schemaVersion: 2,
        defaultProfileId: "default",
        profiles: [],
        rules: [${JSON.stringify(FULL_CAPTURE_RULE)}],
        extendedCaptureHosts: []
      }
    }).then(() => true)
  `);

  const tabId = await popup.evaluate(`
    chrome.tabs.query({}).then((tabs) =>
      tabs.find((tab) => tab.url?.startsWith(${JSON.stringify(pageUrl)}))?.id ?? null
    )
  `);
  assert(typeof tabId === "number", "Demo page tab not found", { tabId });

  const preview = await popup.evaluate(
    `chrome.runtime.sendMessage({ kind: "ui.resolve-profile", tabId: ${tabId} })`
  );
  assert(
    preview?.selection?.id === "builtin:full-capture",
    "Rule did not select the Full capture profile",
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
  await runScenario(page, RAW_SECRETS);

  // Same tab, host without a rule: the session switches to Default, which masks content again.
  const defaultUrl = `http://localhost:${appPort}/fc/`;
  await page.send("Page.navigate", { url: defaultUrl });
  await waitFor(
    () =>
      page.evaluate(
        `(location.hostname === "localhost" && document.readyState === "complete" && typeof window.__runScenario === "function") || null`
      ),
    15_000,
    "Navigation to the rule-free host did not finish"
  );
  await sleep(2_500);
  await runScenario(page, DEFAULT_SECRETS);

  const sid = await popup.evaluate(`
    chrome.storage.local.get("webblackbox.runtime.sessions").then(
      (store) => store["webblackbox.runtime.sessions"]?.[0]?.sid ?? null
    )
  `);
  assert(typeof sid === "string", "Active session not found", { sid });

  for (const refused of [undefined, "short"]) {
    const result = await popup.evaluate(
      `chrome.runtime.sendMessage({ kind: "ui.export", sid: ${JSON.stringify(sid)}, saveAs: false${
        refused === undefined ? "" : `, passphrase: ${JSON.stringify(refused)}`
      } })`
    );
    assert(
      result?.ok === false && /always encrypted/i.test(result.error ?? ""),
      "An export without a valid passphrase was not refused",
      result
    );
  }

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
  const rawArchive = new TextDecoder("latin1").decode(bytes);
  const player = await WebBlackboxPlayer.open(bytes, { passphrase });
  const events = player.query();
  const blobTexts = await Promise.all(
    events
      .filter((event) => typeof event.data?.contentHash === "string")
      .map(async (event) => {
        const blob = await player.getBlob(event.data.contentHash);
        return blob ? new TextDecoder().decode(blob.bytes) : "";
      })
  );
  const recorded = `${JSON.stringify(events)}\n${blobTexts.join("\n")}`;
  const fullCaptureConfig = events.find(
    (event) => event.type === "meta.config" && event.data?.profile?.id === "builtin:full-capture"
  );

  assert(fullCaptureConfig, "meta.config does not record the Full capture profile");
  assert(player.archive.manifest.protocolVersion === 2, "Archive is not in the encrypted format", {
    protocolVersion: player.archive.manifest.protocolVersion
  });

  for (const [kind, secret] of Object.entries(RAW_SECRETS)) {
    assert(recorded.includes(secret), `Full capture did not record the ${kind} secret raw`, {
      secret,
      types: [...new Set(events.map((event) => event.type))]
    });
    assert(!rawArchive.includes(secret), `The ${kind} secret is readable in the archive bytes`);
  }

  for (const [kind, secret] of Object.entries(DEFAULT_SECRETS)) {
    assert(!recorded.includes(secret), `The Default profile recorded the ${kind} secret`, {
      secret
    });
  }

  assert(!rawArchive.includes("127.0.0.1"), "The site appears in the archive's plaintext");
  assert(swExceptions.length === 0, "Service worker threw", swExceptions);

  console.log(`Archive: ${archivePath} (${bytes.byteLength} bytes)`);
  console.log(`Profile: ${JSON.stringify(fullCaptureConfig.data.profile)}`);
  console.log(`Raw secrets found: ${Object.keys(RAW_SECRETS).join(", ")}`);
  console.log(`Chrome log: ${harness.chromeLogPath}`);
  console.log("Profile full capture E2E passed.");

  await harness.cleanup();
}

/** Plants `secrets` through the page: console, storage, a request, and a password field. */
async function runScenario(page, secrets) {
  const result = await page.evaluate(`window.__runScenario(${JSON.stringify(secrets)})`);
  assert(result?.echo === secrets.responseBody, "Demo request failed", result);

  await page.evaluate(`document.querySelector("input[name=password]").focus()`);
  await page.send("Input.insertText", { text: secrets.password });
  await sleep(2_500);
}

function startDemoServer() {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Full capture demo</title></head>
<body><h1>Full capture demo</h1><input name="password" type="password">
<script>
  window.__runScenario = async (secrets) => {
    console.log("password=" + secrets.console);
    localStorage.setItem("authToken", secrets.storage);
    const response = await fetch("/api/echo?token=" + secrets.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + secrets.header
      },
      body: JSON.stringify({ password: secrets.requestBody, reply: secrets.responseBody })
    });
    return response.json();
  };
</script></body></html>`;

  return new Promise((resolvePort, reject) => {
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/api/echo")) {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
          const sent = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ echo: sent.reply, secret: sent.reply }));
        });
        return;
      }

      if (request.url?.startsWith("/fc/")) {
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
