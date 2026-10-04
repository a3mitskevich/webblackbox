#!/usr/bin/env node

// E2E: local recordings are encrypted at rest and do not outlive the browser session.
// 1. Full capture (raw content) records planted fake secrets; the extension's IndexedDB is read
//    directly over CDP (IndexedDB.requestData): no secret, URL or title is readable, every chunk
//    and blob carries the AES-GCM frame, session rows hold only ids and timestamps. The key's
//    chrome.storage.session area is out of reach of the content script.
// 2. The export still decrypts to the raw secrets, and the recording is deleted after it.
// 3. A second, unexported recording survives in IndexedDB until Chrome is restarted on the same
//    user data dir: then the database is gone and the Sessions page is empty.

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assert, createProfileE2eHarness, sleep, waitFor } from "./lib/profile-e2e-harness.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(root, "..");
const repoRoot = resolve(appRoot, "..", "..");
const harness = createProfileE2eHarness({
  name: "at-rest-encryption",
  appRoot,
  defaultPort: "9238"
});
const passphrase = "webblackbox-at-rest-e2e";
const PIPELINE_DB_NAME = "webblackbox-flight-recorder";
const AT_REST_KEY_STORAGE_KEY = "webblackbox.atRest.sessionKey";
const WBE1 = "WBE1";
const PAGE_TITLE = "AtRestTitleMarker";
const SECRETS = {
  console: "AR-CONSOLE-SECRET-1",
  storage: "AR-STORAGE-SECRET-1",
  url: "AR-URL-TOKEN-1",
  header: "AR-HEADER-SECRET-1",
  requestBody: "AR-REQUEST-BODY-1",
  responseBody: "AR-RESPONSE-BODY-1",
  password: "AR-PASSWORD-1"
};
const SECOND_SECRETS = Object.fromEntries(
  Object.entries(SECRETS).map(([kind, value]) => [kind, value.replace("-1", "-2")])
);
const FULL_CAPTURE_RULE = {
  id: "e2e-at-rest-full-capture",
  name: "Local full capture",
  profileId: "builtin:full-capture",
  priority: 10,
  enabled: true,
  match: { hosts: ["127.0.0.1:*"] }
};
/** Serializes an IndexedDB value in its own realm; bytes become Latin-1 text plus their size. */
const SERIALIZE_VALUE = `function () {
  const seen = new WeakSet();
  const walk = (value) => {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const bytes = value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      let text = "";
      for (let index = 0; index < bytes.length; index += 1) text += String.fromCharCode(bytes[index]);
      return { __bytes: bytes.length, text };
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      if (seen.has(value)) return null;
      seen.add(value);
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry)]));
    }
    return value;
  };
  return JSON.stringify(walk(this));
}`;

main().catch(async (error) => {
  console.error(
    "At-rest encryption E2E failed:",
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
  const pageUrl = `http://127.0.0.1:${appPort}/rest/?token=${SECRETS.url}`;
  const first = await harness.launch(pageUrl);
  const { popup, extensionId } = first;
  const origin = `chrome-extension://${extensionId}`;

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
  const firstKey = await readSessionKey(popup);
  assert(firstKey?.keyId, "No at-rest key in chrome.storage.session", firstKey);

  // 1. Record with planted secrets, stop, and read the raw IndexedDB.
  const tabId = await findTabId(popup, pageUrl);
  const sid = await recordSession(first, tabId, SECRETS);
  const raw = await dumpPipelineDb(origin);
  assert(raw, "Pipeline database not found after recording");
  const rows = summarizeRows(raw);

  assert(rows.sessions.length === 1, "Expected one stored session", rows.counts);
  assert(rows.chunks.length > 0, "No stored chunks", rows.counts);
  assert(rows.blobs.length > 0, "No stored blobs (bodies or screenshots)", rows.counts);

  for (const chunk of rows.chunks) {
    assert(chunk.value?.bytes?.text?.startsWith(WBE1), "A chunk is not AES-GCM framed");
  }

  for (const blob of rows.blobs) {
    assert(blob.value?.bytes?.text?.startsWith(WBE1), "A blob is not AES-GCM framed");
  }

  const sessionRow = rows.sessions[0]?.value ?? {};
  assert(sessionRow.sid === sid && sessionRow.url === "", "Session row is not sealed", {
    keys: Object.keys(sessionRow)
  });
  assert(sessionRow.title === undefined && sessionRow.sealed?.__bytes > 0, "Session row leaks");

  const rawText = JSON.stringify(raw);
  const leaks = [...Object.values(SECRETS), PAGE_TITLE, `127.0.0.1:${appPort}`].filter((marker) =>
    rawText.includes(marker)
  );
  assert(leaks.length === 0, "Plaintext found in the extension's IndexedDB", leaks);

  const contentScriptAccess = await readSessionStorageFromContentScript(first.page, origin);
  assert(
    contentScriptAccess.startsWith("denied"),
    "A content script can read chrome.storage.session",
    contentScriptAccess
  );

  const localStorageArea = JSON.stringify(await popup.evaluate("chrome.storage.local.get(null)"));
  assert(
    !Object.values(SECRETS).some((secret) => localStorageArea.includes(secret)) &&
      !localStorageArea.includes(AT_REST_KEY_STORAGE_KEY),
    "chrome.storage.local holds a secret or the key"
  );

  // 2. Export: decrypts to the raw secrets; Full capture deletes the recording afterwards.
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
  const blobTexts = await Promise.all(
    events
      .filter((event) => typeof event.data?.contentHash === "string")
      .map(async (event) => {
        const blob = await player.getBlob(event.data.contentHash);
        return blob ? new TextDecoder().decode(blob.bytes) : "";
      })
  );
  const recorded = `${JSON.stringify(events)}\n${blobTexts.join("\n")}`;
  const missing = Object.entries(SECRETS).filter(([, secret]) => !recorded.includes(secret));
  assert(missing.length === 0, "The export lacks recorded secrets", missing);

  await waitFor(
    async () => ((await listSessionSids(popup)).includes(sid) ? null : true),
    10_000,
    "The exported recording is still listed"
  );
  await waitFor(
    async () => summarizeRows((await dumpPipelineDb(origin)) ?? {}).sessions.length === 0 || null,
    10_000,
    "The exported recording is still in IndexedDB"
  );

  // 3. An unexported recording, then a browser restart on the same profile.
  const secondSid = await recordSession(first, tabId, SECOND_SECRETS);
  const beforeRestart = summarizeRows((await dumpPipelineDb(origin)) ?? {});
  assert(
    beforeRestart.sessions.some((row) => row.value?.sid === secondSid),
    "The unexported recording is not in IndexedDB before the restart",
    beforeRestart.counts
  );
  assert(first.swExceptions.length === 0, "Service worker threw", first.swExceptions);

  await sleep(1_500);
  await harness.stopBrowser();
  const second = await harness.launch("about:blank", { keepProfile: true });
  const afterRestart = await waitFor(
    async () => {
      const dump = await dumpPipelineDb(origin);
      const summary = summarizeRows(dump ?? {});
      return summary.total === 0 ? { databaseExists: dump !== null, ...summary.counts } : null;
    },
    20_000,
    "Unexported recordings survived the browser restart"
  );
  const secondKey = await readSessionKey(second.popup);
  assert(
    secondKey?.keyId && secondKey.keyId !== firstKey.keyId,
    "The browser restart did not mint a new key",
    { before: firstKey.keyId, after: secondKey?.keyId }
  );
  assert((await listSessionSids(second.popup)).length === 0, "Sessions are listed after restart");

  const sessionsPage = await harness.attach(
    await openExtensionPage(second.popup, `${origin}/sessions.html`)
  );
  await sessionsPage.send("Runtime.enable");
  const sessionsView = await waitFor(
    () =>
      sessionsPage.evaluate(`(() => {
        const empty = document.querySelector(".wb-sessions-empty");
        return empty ? {
          cards: document.querySelectorAll(".wb-sessions-list > :not(.wb-sessions-empty)").length,
          text: document.body.innerText
        } : null;
      })()`),
    15_000,
    "Sessions page did not render"
  );
  assert(sessionsView.cards === 0, "Sessions page shows entries after restart", sessionsView);
  assert(
    sessionsView.text.includes("Unexported recordings are cleared when the browser restarts."),
    "Sessions page lacks the restart notice"
  );
  assert(second.swExceptions.length === 0, "Service worker threw", second.swExceptions);

  console.log(`IndexedDB before export: ${JSON.stringify(rows.counts)}`);
  console.log(`IndexedDB after restart: ${JSON.stringify(afterRestart)}`);
  console.log(`Archive: ${archivePath} (${bytes.byteLength} bytes, ${events.length} events)`);
  console.log(`Chrome log: ${harness.chromeLogPath}`);
  console.log("At-rest encryption E2E passed.");

  await harness.cleanup();
}

/** Starts a Full capture recording, plants `secrets`, stops it and returns its sid. */
async function recordSession({ page, popup }, tabId, secrets) {
  await page.send("Page.reload");
  await waitFor(
    () =>
      page.evaluate(
        `(document.readyState === "complete" && typeof window.__runScenario === "function") || null`
      ),
    15_000,
    "Demo page did not load"
  );
  await popup.evaluate(
    `chrome.runtime.sendMessage({ kind: "ui.start", tabId: ${tabId}, mode: "full", visualCapture: "screenshots" })`
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

  const result = await page.evaluate(`window.__runScenario(${JSON.stringify(secrets)})`);
  assert(result?.echo === secrets.responseBody, "Demo request failed", result);
  await page.evaluate(`document.querySelector("input[name=password]").focus()`);
  await page.send("Input.insertText", { text: secrets.password });
  await sleep(2_500);

  const sid = await popup.evaluate(`
    chrome.storage.local.get("webblackbox.runtime.sessions").then(
      (store) => store["webblackbox.runtime.sessions"]?.[0]?.sid ?? null
    )
  `);
  assert(typeof sid === "string", "Active session not found", { sid });
  await popup.evaluate(`chrome.runtime.sendMessage({ kind: "ui.stop", tabId: ${tabId} })`);
  await waitFor(
    async () => ((await listSessionSids(popup, { activeOnly: true })).length === 0 ? true : null),
    15_000,
    "Recording did not stop"
  );
  await sleep(1_000);
  return sid;
}

/** Tries to read `chrome.storage.session` from the extension's content script world. */
async function readSessionStorageFromContentScript(page, origin) {
  const contexts = [];
  page.on("Runtime.executionContextCreated", ({ context }) => contexts.push(context));
  // Re-enabling reports every live execution context, the isolated worlds included.
  await page.send("Runtime.disable");
  await page.send("Runtime.enable");
  const contentWorld = await waitFor(
    () =>
      contexts.find(
        (context) => context.origin === origin && context.auxData?.type === "isolated"
      ) ?? null,
    5_000,
    "Content script world not found"
  );
  const result = await page.send("Runtime.evaluate", {
    contextId: contentWorld.id,
    expression: `Promise.resolve()
      .then(() => chrome.storage.session.get(null))
      .then((values) => "readable:" + Object.keys(values).join(","), (error) => "denied:" + error.message)`,
    awaitPromise: true,
    returnByValue: true
  });

  return result?.exceptionDetails
    ? `denied:${result.exceptionDetails.text}`
    : String(result?.result?.value);
}

async function findTabId(popup, pageUrl) {
  const tabId = await popup.evaluate(`
    chrome.tabs.query({}).then((tabs) =>
      tabs.find((tab) => tab.url?.startsWith(${JSON.stringify(pageUrl)}))?.id ?? null
    )
  `);
  assert(typeof tabId === "number", "Demo page tab not found", { tabId });
  return tabId;
}

async function listSessionSids(popup, { activeOnly = false } = {}) {
  const list = await popup.evaluate(
    `chrome.runtime.sendMessage({ kind: "ui.request-session-list" })`
  );
  return (list?.sessions ?? [])
    .filter((session) => !activeOnly || session.active)
    .map((session) => session.sid);
}

function readSessionKey(popup) {
  return popup.evaluate(
    `chrome.storage.session.get(${JSON.stringify(AT_REST_KEY_STORAGE_KEY)}).then(
      (store) => store[${JSON.stringify(AT_REST_KEY_STORAGE_KEY)}] ?? null
    )`
  );
}

async function openExtensionPage(popup, url) {
  await popup.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(url)} }).then(() => true)`);
  return waitFor(
    async () => (await harness.listTargets()).find((target) => target.url === url) ?? null,
    10_000,
    `Extension page did not open: ${url}`
  );
}

/**
 * Reads every row of the pipeline database over the CDP IndexedDB domain, from the offscreen
 * document when it is alive, otherwise from another page of the extension's origin.
 */
async function dumpPipelineDb(origin) {
  const targets = await harness.listTargets();
  const target =
    targets.find((entry) => entry.url === `${origin}/offscreen.html`) ??
    targets.find((entry) => entry.url?.startsWith(`${origin}/`) && entry.type === "page");
  assert(target, "No extension page to read IndexedDB from");

  const client = await harness.attach(target);

  try {
    await client.send("IndexedDB.enable");
    const scope = { storageKey: `${origin}/` };
    const { databaseNames } = await client.send("IndexedDB.requestDatabaseNames", scope);

    if (!databaseNames.includes(PIPELINE_DB_NAME)) {
      return null;
    }

    const { databaseWithObjectStores } = await client.send("IndexedDB.requestDatabase", {
      ...scope,
      databaseName: PIPELINE_DB_NAME
    });
    const stores = {};

    for (const store of databaseWithObjectStores.objectStores) {
      stores[store.name] = await readStore(client, scope, store.name);
    }

    return stores;
  } finally {
    client.close();
  }
}

async function readStore(client, scope, objectStoreName) {
  const rows = [];

  while (true) {
    const { objectStoreDataEntries, hasMore } = await client.send("IndexedDB.requestData", {
      ...scope,
      databaseName: PIPELINE_DB_NAME,
      objectStoreName,
      skipCount: rows.length,
      pageSize: 25
    });

    for (const entry of objectStoreDataEntries) {
      rows.push(await serializeRemoteObject(client, entry.value));
    }

    if (!hasMore || objectStoreDataEntries.length === 0) {
      return rows;
    }
  }
}

async function serializeRemoteObject(client, remote) {
  if (!remote?.objectId) {
    return remote?.value ?? null;
  }

  const result = await client.send("Runtime.callFunctionOn", {
    objectId: remote.objectId,
    functionDeclaration: SERIALIZE_VALUE,
    returnByValue: true
  });
  await client.send("Runtime.releaseObject", { objectId: remote.objectId }).catch(() => undefined);
  return JSON.parse(result?.result?.value ?? "null");
}

function summarizeRows(stores) {
  const pick = (name) => stores?.[name] ?? [];
  const summary = {
    sessions: pick("sessions"),
    chunks: pick("chunks"),
    blobs: pick("blobs"),
    indexes: pick("indexes"),
    integrity: pick("integrity"),
    blobRefs: pick("blobRefs")
  };
  const counts = Object.fromEntries(
    Object.entries(summary).map(([key, rows]) => [key, rows.length])
  );

  return {
    ...summary,
    counts,
    total: Object.values(counts).reduce((sum, count) => sum + count, 0)
  };
}

function startDemoServer() {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${PAGE_TITLE}</title></head>
<body><h1>At-rest demo</h1><input name="password" type="password">
<script>
  window.__runScenario = async (secrets) => {
    console.log("password=" + secrets.console);
    // Enough events to fill several 512 KiB chunks, so chunks reach IndexedDB before export.
    for (let index = 0; index < 3000; index += 1) {
      console.log("bulk " + index + " " + secrets.console + " " + "y".repeat(240));
    }
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

      if (request.url?.startsWith("/rest/")) {
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
