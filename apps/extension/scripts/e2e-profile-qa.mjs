#!/usr/bin/env node

// E2E: a site rule picks the QA profile on a matching host and the exported archive contains
// console text and JSON response bodies; exporting without a passphrase is refused.

import { spawn, spawnSync } from "node:child_process";
import { constants, createWriteStream } from "node:fs";
import { access, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(root, "..");
const repoRoot = resolve(appRoot, "..", "..");

const extensionDir = process.env.WB_E2E_EXTENSION_DIR ?? resolve(appRoot, "build");
const remotePort = Number(process.env.WB_E2E_REMOTE_PORT ?? "9231");
const headless = (process.env.WB_E2E_HEADLESS ?? "1") !== "0";
const runId = Date.now();
const profileDir = process.env.WB_E2E_PROFILE_DIR ?? `/tmp/webblackbox-profile-qa-${runId}`;
const downloadDir = `/tmp/webblackbox-profile-qa-downloads-${runId}`;
const chromeLogPath = process.env.WB_E2E_LOG ?? `/tmp/webblackbox-profile-qa-${runId}.log`;
const baseUrl = `http://127.0.0.1:${remotePort}`;
const passphrase = "webblackbox-qa-e2e-passphrase";

const CONSOLE_MARKER = "qa-console-marker-7f3a";
const BODY_MARKER = "qa-body-marker-91c2";
const QA_RULE = {
  id: "e2e-local-qa",
  name: "Local QA",
  profileId: "builtin:qa",
  priority: 10,
  enabled: true,
  match: { hosts: ["127.0.0.1:*"] }
};

const chromeCandidates = [
  process.env.WB_E2E_CHROME_BIN,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "google-chrome",
  "chromium"
].filter(Boolean);

const state = { chrome: null, logStream: null, server: null, clients: [] };

main().catch(async (error) => {
  console.error("Profile QA E2E failed:", error instanceof Error ? error.message : String(error));
  await cleanup();
  process.exit(1);
});

async function main() {
  await access(resolve(extensionDir, "manifest.json"), constants.R_OK);
  const { WebBlackboxPlayer } = await import(
    pathToFileURL(resolve(repoRoot, "packages/player-sdk/dist/index.js")).href
  );
  const appPort = await startDemoServer();
  const pageUrl = `http://127.0.0.1:${appPort}/qa/`;

  await rm(profileDir, { recursive: true, force: true });
  await mkdir(profileDir, { recursive: true });
  await mkdir(downloadDir, { recursive: true });
  startChrome(await resolveChromeBinary(chromeCandidates));

  const version = await waitFor(
    () => fetchJson(`${baseUrl}/json/version`).then((v) => (v?.Browser ? v : null)),
    20_000,
    "Chrome DevTools endpoint not ready"
  );
  console.log(`Chrome: ${version.Browser}`);

  const browser = await connect(version.webSocketDebuggerUrl);
  await browser.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDir,
    eventsEnabled: true
  });

  const swTarget = await waitFor(
    async () =>
      (await fetchJson(`${baseUrl}/json/list`)).find(
        (target) => target?.type === "service_worker" && target.url?.endsWith("/sw.js")
      ) ?? null,
    20_000,
    "Extension service worker not found"
  );
  const extensionId = /^chrome-extension:\/\/([^/]+)\//.exec(swTarget.url)?.[1];
  const sw = await connect(swTarget.webSocketDebuggerUrl);
  const swExceptions = [];
  await sw.send("Runtime.enable");
  sw.on("Runtime.exceptionThrown", (params) => {
    swExceptions.push(params?.exceptionDetails?.text ?? "unknown");
  });

  const page = await connect((await openTarget(pageUrl)).webSocketDebuggerUrl);
  const popup = await connect(
    (await openTarget(`chrome-extension://${extensionId}/popup.html`)).webSocketDebuggerUrl
  );
  await page.send("Runtime.enable");
  await popup.send("Runtime.enable");
  await sleep(1_000);

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

  const pageResult = await page.evaluate(`window.__runQaScenario()`);
  assert(pageResult?.marker === BODY_MARKER, "Demo request failed", pageResult);
  await sleep(2_500);

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
    plaintext?.ok === false && /encrypted export/i.test(plaintext.error ?? ""),
    "Plaintext export of a QA session was not refused",
    plaintext
  );

  const exported = await popup.evaluate(`
    chrome.runtime.sendMessage({
      kind: "ui.export",
      sid: ${JSON.stringify(sid)},
      passphrase: ${JSON.stringify(passphrase)},
      saveAs: false,
      acknowledgePrivacyFindings: true
    })
  `);
  assert(exported?.ok === true, "Encrypted export failed", exported);

  const archivePath = await waitFor(
    async () => {
      const files = (await readdir(downloadDir)).filter((file) => !file.endsWith(".crdownload"));
      return files.length > 0 ? resolve(downloadDir, files[0]) : null;
    },
    30_000,
    "Exported archive was not downloaded"
  );
  const bytes = new Uint8Array(await readFile(archivePath));
  const player = await WebBlackboxPlayer.open(bytes, { passphrase });
  const events = player.query();
  const manifestText = JSON.stringify(player.archive.manifest);
  const profileConfig = events.find(
    (event) => event.type === "meta.config" && event.data?.profile?.id === "builtin:qa"
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

  assert(profileConfig, "meta.config does not record the QA profile");
  assert(profileConfig.data.profile.ruleId === QA_RULE.id, "meta.config misses the rule", {
    profile: profileConfig.data.profile
  });
  assert(consoleEvent, "Console text missing from the QA archive", {
    types: [...new Set(events.map((event) => event.type))]
  });
  assert(jsonBody, "JSON response body missing from the QA archive", {
    bodies: bodyEvents.length
  });
  assert(!jsonBody.includes("hunter2"), "Sensitive body value was not masked", { jsonBody });
  assert(!manifestText.includes("alice@example.com"), "Page title leaked into the manifest");
  assert(swExceptions.length === 0, "Service worker threw", swExceptions);

  console.log(`Archive: ${archivePath} (${bytes.byteLength} bytes)`);
  console.log(`Profile: ${JSON.stringify(profileConfig.data.profile)}`);
  console.log(`Console event: ${JSON.stringify(consoleEvent.data).slice(0, 200)}`);
  console.log(`JSON body: ${jsonBody.slice(0, 200)}`);
  console.log(`Plaintext export refused: ${plaintext.error}`);
  console.log(`Chrome log: ${chromeLogPath}`);
  console.log("Profile QA E2E passed.");

  await cleanup();
}

function startDemoServer() {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>QA demo for alice@example.com</title></head>
<body><h1>QA demo</h1><input name="password" type="password">
<script>
  window.__runQaScenario = async () => {
    console.log(${JSON.stringify(CONSOLE_MARKER)}, { orderId: 42 });
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
    password: "hunter2"
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

    state.server = server;
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePort(server.address().port));
  });
}

function startChrome(binary) {
  const args = [
    `--remote-debugging-port=${remotePort}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-component-update",
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "--enable-logging=stderr",
    "about:blank"
  ];

  if (headless) {
    args.unshift("--headless=new");
  }

  state.chrome = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  state.logStream = createWriteStream(chromeLogPath, { flags: "a" });
  state.chrome.stdout?.pipe(state.logStream);
  state.chrome.stderr?.pipe(state.logStream);
}

async function resolveChromeBinary(candidates) {
  for (const candidate of candidates) {
    if (isAbsolute(candidate)) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }

    const which = spawnSync("which", [candidate], { encoding: "utf8" });

    if (which.status === 0 && which.stdout.trim()) {
      return which.stdout.trim().split("\n")[0];
    }
  }

  throw new Error("Chrome binary not found. Set WB_E2E_CHROME_BIN.");
}

async function openTarget(url) {
  return fetchJson(`${baseUrl}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
}

async function connect(wsUrl) {
  const client = new CdpClient(wsUrl);
  await client.connect();
  state.clients.push(client);
  return client;
}

async function fetchJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(6_000) });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.json();
}

async function waitFor(fn, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const result = await fn();

      if (result !== null && result !== undefined) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(250);
  }

  throw new Error(lastError instanceof Error ? `${message}: ${lastError.message}` : message);
}

function assert(condition, message, details) {
  if (!condition) {
    throw new Error(details === undefined ? message : `${message} | ${JSON.stringify(details)}`);
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function cleanup() {
  for (const client of state.clients.splice(0)) {
    client.close();
  }

  state.chrome?.kill("SIGTERM");
  state.chrome = null;
  state.server?.close();
  state.server = null;

  if (state.logStream) {
    await new Promise((resolveEnd) => state.logStream.end(resolveEnd));
    state.logStream = null;
  }
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.sequence = 0;
    this.pending = new Map();
    this.handlers = new Map();
  }

  connect() {
    return new Promise((resolveOpen, reject) => {
      const socket = new WebSocket(this.wsUrl);
      this.socket = socket;
      socket.addEventListener("open", () => resolveOpen());
      socket.addEventListener("error", () => reject(new Error(`WebSocket failed: ${this.wsUrl}`)));
      socket.addEventListener("message", (event) => {
        const payload = JSON.parse(String(event.data));

        if (typeof payload.id === "number") {
          const pending = this.pending.get(payload.id);
          this.pending.delete(payload.id);

          if (payload.error) {
            pending?.reject(new Error(payload.error.message ?? "CDP error"));
          } else {
            pending?.resolve(payload.result);
          }

          return;
        }

        for (const handler of this.handlers.get(payload.method) ?? []) {
          handler(payload.params ?? {});
        }
      });
    });
  }

  on(method, handler) {
    this.handlers.set(method, [...(this.handlers.get(method) ?? []), handler]);
  }

  send(method, params = {}) {
    const id = ++this.sequence;

    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });

    if (result?.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      );
    }

    return result?.result?.value;
  }

  close() {
    this.socket?.close();
  }
}
