#!/usr/bin/env node

// E2E: the Full capture preset, chosen explicitly on a host without any site rule, records content
// as captured (no masking, no host restriction). Planted fake secrets (console text, storage
// value, URL token, Authorization header, request and response bodies, password field, WebSocket
// payload) and the raw DOM must be present in the decrypted archive. After the tab moves to
// another host the explicit choice still applies: the recording keeps going and records the second
// set raw too. The archive itself is always encrypted: none of the secrets, nor the site, appear
// in its raw bytes, and an export without a passphrase is refused.

import { createHash } from "node:crypto";
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
  password: "FC-PASSWORD-1",
  webSocket: "FC-WS-PAYLOAD-1",
  cookie: "FC-COOKIE-SECRET-1",
  httpOnlyCookie: "FC-HTTPONLY-SECRET-1",
  indexedDb: "FC-IDB-SECRET-1"
};
/** The same kinds of secrets planted on another host: the explicit choice still records them. */
const OTHER_HOST_SECRETS = {
  console: "OH-CONSOLE-SECRET-2",
  storage: "OH-STORAGE-SECRET-2",
  url: "OH-URL-TOKEN-2",
  header: "OH-HEADER-SECRET-2",
  requestBody: "OH-REQUEST-BODY-2",
  responseBody: "OH-RESPONSE-BODY-2",
  password: "OH-PASSWORD-2",
  webSocket: "OH-WS-PAYLOAD-2",
  cookie: "OH-COOKIE-SECRET-2",
  httpOnlyCookie: "OH-HTTPONLY-SECRET-2",
  indexedDb: "OH-IDB-SECRET-2"
};
/** Text in the page markup: only a raw DOM snapshot carries it into the archive. */
const DOM_MARKER = "FC-DOM-MARKER-1";
/** Rows the scenario adds over a few seconds: later DOM snapshots must follow them. */
const DOM_CHANGE_ROWS = 10;
const FULL_CAPTURE_ID = "builtin:full-capture";

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
        rules: [],
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
    `chrome.runtime.sendMessage({ kind: "ui.resolve-profile", tabId: ${tabId}, profileId: ${JSON.stringify(FULL_CAPTURE_ID)} })`
  );
  assert(
    preview?.selection?.id === FULL_CAPTURE_ID && preview.selection.source === "explicit",
    "Full capture is not used as chosen on a host without rules",
    preview
  );

  await popup.evaluate(
    `chrome.runtime.sendMessage({ kind: "ui.start", tabId: ${tabId}, mode: "full", visualCapture: "none", profileId: ${JSON.stringify(FULL_CAPTURE_ID)} })`
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

  const listSessions = () =>
    popup.evaluate(
      `chrome.runtime.sendMessage({ kind: "ui.request-session-list" }).then((list) => list?.sessions ?? [])`
    );
  const sid = (await listSessions()).find((session) => session.active)?.sid;
  assert(typeof sid === "string", "Active session not found", { sid });

  // Same tab, another host: the explicit choice applies there too, so recording goes on.
  const otherHostUrl = `http://localhost:${appPort}/fc/`;
  await page.send("Page.navigate", { url: otherHostUrl });
  await waitFor(
    () =>
      page.evaluate(
        `(location.hostname === "localhost" && document.readyState === "complete" && typeof window.__runScenario === "function") || null`
      ),
    15_000,
    "Navigation to the other host did not finish"
  );
  await sleep(2_500);
  await runScenario(page, OTHER_HOST_SECRETS);

  const session = (await listSessions()).find((entry) => entry.sid === sid);
  assert(
    session?.active === true && !session.profileCancel,
    "The recording did not keep going on the other host",
    session
  );

  // Stopping takes the last cookie snapshot (CDP, HttpOnly cookies included).
  const stopped = await popup.evaluate(
    `chrome.runtime.sendMessage({ kind: "ui.stop", tabId: ${tabId} })`
  );
  assert(stopped?.ok !== false, "Stopping the recording failed", stopped);
  await sleep(1_500);

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
    (event) => event.type === "meta.config" && event.data?.profile?.id === FULL_CAPTURE_ID
  );
  const otherConfig = events.find(
    (event) =>
      event.type === "meta.config" &&
      (event.data?.profile?.id !== FULL_CAPTURE_ID || event.data?.profileCancel)
  );
  const rawDomSnapshots = events.filter(
    (event) => event.type === "dom.snapshot" && event.data?.source === "html"
  );
  const wsFrames = events.filter((event) => event.type === "network.ws.frame");

  assert(fullCaptureConfig, "meta.config does not record the Full capture profile");
  assert(
    fullCaptureConfig.data.profile.source === "explicit" &&
      !fullCaptureConfig.data.profile.downgradedFrom,
    "Full capture was not recorded as chosen",
    fullCaptureConfig.data.profile
  );
  assert(!otherConfig, "The recording changed or cancelled its profile", {
    config: otherConfig?.data
  });
  assert(rawDomSnapshots.length > 0, "Full capture did not record the raw DOM", {
    types: [...new Set(events.map((event) => event.type))]
  });
  assert(recorded.includes(DOM_MARKER), "The raw DOM snapshot misses the page markup");
  assert(wsFrames.length > 0, "Full capture did not record WebSocket frames", {
    types: [...new Set(events.map((event) => event.type))]
  });
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

  for (const [kind, secret] of Object.entries(OTHER_HOST_SECRETS)) {
    assert(
      recorded.includes(secret),
      `Full capture did not record the ${kind} secret on the other host`,
      {
        secret
      }
    );
    assert(!rawArchive.includes(secret), `The ${kind} secret is readable in the archive bytes`);
  }

  // Values, not names: cookie values (HttpOnly too, through CDP) and IndexedDB records.
  const cookieEntries = events
    .filter((event) => event.type === "storage.cookie.snapshot")
    .flatMap((event) => (Array.isArray(event.data?.cookies) ? event.data.cookies : []));
  const idbRecords = events
    .filter((event) => event.type === "storage.idb.snapshot")
    .flatMap((event) => event.data?.databases ?? [])
    .flatMap((database) => database.stores ?? [])
    .flatMap((store) => store.records ?? []);

  for (const secrets of [RAW_SECRETS, OTHER_HOST_SECRETS]) {
    assert(
      cookieEntries.some((entry) => entry.name === "fc_cookie" && entry.value === secrets.cookie),
      "Full capture did not record the page cookie value",
      { cookieEntries }
    );
    assert(
      cookieEntries.some(
        (entry) =>
          entry.name === "fc_http" &&
          entry.value === secrets.httpOnlyCookie &&
          entry.httpOnly === true
      ),
      "Full capture did not record the HttpOnly cookie value",
      { cookieEntries }
    );
  }

  for (const secrets of [RAW_SECRETS, OTHER_HOST_SECRETS]) {
    assert(
      idbRecords.some((record) => record.value?.includes(secrets.indexedDb)),
      "Full capture did not record the IndexedDB record",
      { idbRecords }
    );
  }

  // DOM changes: summaries and snapshots taken because the page changed, the last one current.
  const changeSnapshots = rawDomSnapshots.filter((event) => event.data?.reason === "mutation");
  const mutationBatches = events.filter((event) => event.type === "dom.mutation.batch");
  const lastRow = `DOM-CHANGE-ROW-${DOM_CHANGE_ROWS - 1}`;
  assert(mutationBatches.length > 0, "Full capture did not record DOM mutations");
  assert(changeSnapshots.length > 0, "Full capture took no DOM snapshot after the page changed", {
    reasons: rawDomSnapshots.map((event) => event.data?.reason)
  });
  assert(recorded.includes(lastRow), "No DOM snapshot shows the page after its last change");

  assert(!rawArchive.includes("127.0.0.1"), "The site appears in the archive's plaintext");
  assert(swExceptions.length === 0, "Service worker threw", swExceptions);

  console.log(`Archive: ${archivePath} (${bytes.byteLength} bytes)`);
  console.log(`Profile: ${JSON.stringify(fullCaptureConfig.data.profile)}`);
  console.log(`Raw secrets found: ${Object.keys(RAW_SECRETS).join(", ")} (both hosts)`);
  console.log(
    `Raw DOM snapshots: ${rawDomSnapshots.length} (${changeSnapshots.length} after changes); ` +
      `mutation batches: ${mutationBatches.length}; WebSocket frames: ${wsFrames.length}`
  );
  console.log(`Cookie values: ${cookieEntries.length}; IndexedDB records: ${idbRecords.length}`);
  console.log(`Chrome log: ${harness.chromeLogPath}`);
  console.log("Profile full capture E2E passed.");

  await harness.cleanup();
}

/**
 * Plants `secrets` through the page: console, storage, a request, a WebSocket message (echoed by
 * the server), and a password field.
 */
async function runScenario(page, secrets) {
  const result = await page.evaluate(`window.__runScenario(${JSON.stringify(secrets)})`);
  assert(result?.echo === secrets.responseBody, "Demo request failed", result);
  assert(result?.wsEcho === secrets.webSocket, "Demo WebSocket echo failed", result);

  await page.evaluate(`document.querySelector("input[name=password]").focus()`);
  await page.send("Input.insertText", { text: secrets.password });
  await sleep(2_500);
  // A marker snapshots the DOM and storage (IndexedDB records included) right now.
  await page.evaluate(
    `window.postMessage({ source: "webblackbox-injected", kind: "marker", message: "fc storage" }, "*")`
  );
  await sleep(1_500);
}

function startDemoServer() {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Full capture demo</title></head>
<body><h1>Full capture demo</h1><p>${DOM_MARKER}</p><input name="password" type="password">
<ul id="rows"></ul>
<script>
  const echoOverWebSocket = (text) =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket("ws://" + location.host + "/ws");
      socket.onopen = () => socket.send(text);
      socket.onmessage = (event) => {
        resolve(event.data);
        socket.close();
      };
      socket.onerror = () => reject(new Error("WebSocket failed"));
    });
  const putIndexedDbRecord = (value) =>
    new Promise((resolve, reject) => {
      const open = indexedDB.open("fc-db", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("kv", { keyPath: "id" });
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction("kv", "readwrite");
        tx.objectStore("kv").put({ id: location.host, secret: value });
        tx.oncomplete = () => {
          open.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  const changeDom = (rows) =>
    new Promise((resolve) => {
      let index = 0;
      const list = document.getElementById("rows");
      const timer = setInterval(() => {
        const row = document.createElement("li");
        row.textContent = "DOM-CHANGE-ROW-" + index;
        list.append(row);
        index += 1;
        if (index >= rows) {
          clearInterval(timer);
          resolve();
        }
      }, 400);
    });
  window.__runScenario = async (secrets) => {
    console.log("password=" + secrets.console);
    localStorage.setItem("authToken", secrets.storage);
    document.cookie = "fc_cookie=" + secrets.cookie + "; path=/";
    await putIndexedDbRecord(secrets.indexedDb);
    await changeDom(${DOM_CHANGE_ROWS});
    const response = await fetch("/api/echo?token=" + secrets.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + secrets.header
      },
      body: JSON.stringify({
        password: secrets.requestBody,
        reply: secrets.responseBody,
        httpOnlyCookie: secrets.httpOnlyCookie
      })
    });
    const result = await response.json();
    return { ...result, wsEcho: await echoOverWebSocket(secrets.webSocket) };
  };
</script></body></html>`;

  return new Promise((resolvePort, reject) => {
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/api/echo")) {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
          const sent = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          response.writeHead(200, {
            "content-type": "application/json",
            // Readable through CDP only: the page cannot see HttpOnly cookies.
            "set-cookie": `fc_http=${sent.httpOnlyCookie}; Path=/; HttpOnly`
          });
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

    server.on("upgrade", (request, socket) => acceptEchoWebSocket(request, socket));
    harness.trackServer(server);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePort(server.address().port));
  });
}

/** Minimal RFC 6455 server side: answers the handshake and echoes the first short text frame. */
function acceptEchoWebSocket(request, socket) {
  const key = request.headers["sec-websocket-key"];

  if (!request.url?.startsWith("/ws") || typeof key !== "string") {
    socket.destroy();
    return;
  }

  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.on("error", () => undefined);
  socket.once("data", (frame) => {
    // Client frames are masked; short text frames only (payload < 126 bytes).
    const length = frame[1] & 0x7f;
    const mask = frame.subarray(2, 6);
    const payload = Buffer.from(frame.subarray(6, 6 + length).map((byte, i) => byte ^ mask[i % 4]));
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  });
}
