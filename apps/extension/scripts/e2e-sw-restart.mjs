#!/usr/bin/env node

// Regression e2e for MV3 service-worker restarts:
// 1. record + stop a lite session (the offscreen document stays alive),
// 2. plant an orphaned session in the pipeline IndexedDB,
// 3. terminate the service worker through CDP (`Target.closeTarget`),
// 4. start a new session — it must succeed (the offscreen pipeline is reachable again),
//    export it, and the orphaned IndexedDB session must have been swept.

import { spawn, spawnSync } from "node:child_process";
import { constants, createWriteStream } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(root, "..");

const extensionDir = process.env.WB_E2E_EXTENSION_DIR ?? resolve(appRoot, "build");
const remotePort = Number(process.env.WB_E2E_REMOTE_PORT ?? "9233");
const headless = (process.env.WB_E2E_HEADLESS ?? "1") !== "0";
const profileDir =
  process.env.WB_E2E_PROFILE_DIR ?? `/tmp/webblackbox-ext-sw-restart-profile-${Date.now()}`;
const chromeLogPath = process.env.WB_E2E_LOG ?? `/tmp/webblackbox-ext-sw-restart-${Date.now()}.log`;
const baseUrl = `http://127.0.0.1:${remotePort}`;
const pipelineDbName = "webblackbox-flight-recorder";
const orphanSid = `S-e2e-orphan-${Date.now()}`;

const chromeCandidates = [
  process.env.WB_E2E_CHROME_BIN,
  "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "google-chrome",
  "chromium"
].filter(Boolean);

const state = {
  chromeProcess: null,
  logStream: null,
  server: null,
  clients: []
};

main().catch(async (error) => {
  console.error("SW restart e2e failed:", error instanceof Error ? error.message : String(error));
  console.error(`Chrome log: ${chromeLogPath}`);
  await cleanup();
  process.exit(1);
});

async function main() {
  await access(resolve(extensionDir, "manifest.json"), constants.R_OK);
  const chromeBinary = await resolveChromeBinary(chromeCandidates);
  const pageUrl = await startFixtureServer();

  await rm(profileDir, { recursive: true, force: true });
  await mkdir(profileDir, { recursive: true });
  startChrome(chromeBinary);

  const version = await waitFor(
    () => fetchJson(`${baseUrl}/json/version`, 4_000).then((v) => (v?.Browser ? v : null)),
    20_000,
    "Chrome DevTools endpoint not ready"
  );
  console.log(`Chrome: ${version.Browser}`);

  const swTarget = await waitForServiceWorkerTarget(20_000);
  const extensionId = /^chrome-extension:\/\/([^/]+)\//.exec(swTarget.url)?.[1];
  assert(typeof extensionId === "string", "Failed to parse extension id", swTarget);
  console.log(`Extension ID: ${extensionId}`);

  const browserClient = await connect(version.webSocketDebuggerUrl);
  const pageClient = await connect((await openTarget(pageUrl)).webSocketDebuggerUrl);
  const popupClient = await connect(
    (await openTarget(`chrome-extension://${extensionId}/popup.html`)).webSocketDebuggerUrl
  );
  await sleep(1_000);

  await pageClient.evaluate(`
    (() => {
      window.__wbBridgeMessages = [];
      window.addEventListener('message', (event) => {
        if (event.data && event.data.source === 'webblackbox-injected') {
          window.__wbBridgeMessages.push(typeof event.data.nonce === 'string' ? 'stamped' : 'unstamped');
        }
      });
      return true;
    })()
  `);
  const first = await recordAndStop(popupClient, pageClient, pageUrl);
  console.log("First session:", JSON.stringify(first));

  const bridgeMessages = await pageClient.evaluate(`window.__wbBridgeMessages`);
  assert(
    Array.isArray(bridgeMessages) &&
      bridgeMessages.length > 0 &&
      bridgeMessages.every((entry) => entry === "stamped"),
    "Injected bridge messages must carry the session nonce",
    { bridgeMessages }
  );

  const offscreenBefore = await countOffscreenDocuments(popupClient);
  assert(offscreenBefore === 1, "Offscreen document should outlive the stopped session", {
    offscreenBefore
  });

  await plantOrphanSession(popupClient);
  assert(
    (await listStoredSessionIds(popupClient)).includes(orphanSid),
    "Failed to plant orphan session"
  );

  await terminateServiceWorker(browserClient, swTarget.id);
  console.log("Service worker terminated.");

  const second = await recordAndStop(popupClient, pageClient, pageUrl);
  console.log("Second session (after SW restart):", JSON.stringify(second));

  const exported = await exportSession(popupClient, second.sid);
  assert(exported?.ok === true, "Export after SW restart failed", exported);

  const storedAfter = await waitFor(
    async () => {
      const ids = await listStoredSessionIds(popupClient);
      return ids.includes(orphanSid) ? null : ids;
    },
    10_000,
    "Orphaned IndexedDB session was not swept after SW restart"
  );
  assert(
    storedAfter.includes(first.sid),
    "Stopped session inside its retention window must survive the sweep",
    { storedAfter, first }
  );
  console.log("Stored sessions after restart:", JSON.stringify(storedAfter));
  console.log("SW restart e2e passed.");

  await cleanup();
}

async function recordAndStop(popupClient, pageClient, pageUrl) {
  const start = await popupClient.evaluate(`
    (async () => {
      const tabs = await chrome.tabs.query({});
      const target = tabs.find((tab) => typeof tab.url === 'string' && tab.url.startsWith(${JSON.stringify(pageUrl)}));
      if (!target || typeof target.id !== 'number') {
        return { ok: false, reason: 'target-tab-not-found' };
      }
      const response = await chrome.runtime.sendMessage({ kind: 'ui.start', tabId: target.id, mode: 'lite' });
      return { ok: response?.ok !== false, tabId: target.id, response };
    })()
  `);
  assert(start?.ok === true, "Failed to start lite session", start);

  await waitFor(
    async () => {
      const text = await pageClient.evaluate(
        `document.querySelector('[data-webblackbox-indicator="true"]')?.textContent ?? null`
      );
      return typeof text === "string" && text.includes("REC lite") ? text : null;
    },
    20_000,
    "Recording indicator did not appear"
  );

  await pageClient.evaluate(
    `(() => { console.info('sw-restart-e2e', Date.now()); return true; })()`
  );
  await sleep(500);

  const sessions = await readActiveSessions(popupClient);
  const sid = sessions[0]?.sid;
  assert(typeof sid === "string", "Active session was not persisted", sessions);

  const stop = await popupClient.evaluate(`
    (async () => {
      const response = await chrome.runtime.sendMessage({ kind: 'ui.stop', tabId: ${start.tabId} });
      return { ok: response?.ok !== false, response };
    })()
  `);
  assert(stop?.ok === true, "Failed to stop lite session", stop);

  await waitFor(
    async () => {
      const text = await pageClient.evaluate(
        `document.querySelector('[data-webblackbox-indicator="true"]')?.textContent ?? null`
      );
      return text ? null : true;
    },
    10_000,
    "Recording indicator did not clear"
  );

  return { sid, tabId: start.tabId };
}

async function exportSession(popupClient, sid) {
  return popupClient.evaluate(`
    (async () => {
      const response = await chrome.runtime.sendMessage({ kind: 'ui.export', sid: ${JSON.stringify(sid)} });
      return { ok: response?.ok !== false, response };
    })()
  `);
}

async function readActiveSessions(popupClient) {
  return popupClient.evaluate(`
    (async () => {
      const store = await chrome.storage.local.get('webblackbox.runtime.sessions');
      const rows = store['webblackbox.runtime.sessions'];
      return Array.isArray(rows) ? rows : [];
    })()
  `);
}

async function countOffscreenDocuments(popupClient) {
  return popupClient.evaluate(`
    (async () => {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      return contexts.length;
    })()
  `);
}

async function plantOrphanSession(popupClient) {
  await popupClient.evaluate(`
    (async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(${JSON.stringify(pipelineDbName)});
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('sessions', 'readwrite');
        tx.objectStore('sessions').put({
          key: ${JSON.stringify(orphanSid)},
          value: {
            sid: ${JSON.stringify(orphanSid)},
            tabId: 1,
            startedAt: Date.now() - 60 * 60 * 1000,
            mode: 'lite',
            url: 'https://orphan.invalid/',
            tags: []
          }
        });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return true;
    })()
  `);
}

async function listStoredSessionIds(popupClient) {
  return popupClient.evaluate(`
    (async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(${JSON.stringify(pipelineDbName)});
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (!db.objectStoreNames.contains('sessions')) {
        db.close();
        return [];
      }
      const keys = await new Promise((resolve, reject) => {
        const request = db.transaction('sessions', 'readonly').objectStore('sessions').getAllKeys();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return keys;
    })()
  `);
}

async function terminateServiceWorker(browserClient, targetId) {
  await browserClient.send("Target.closeTarget", { targetId });
  await waitFor(
    async () => {
      const targets = await fetchJson(`${baseUrl}/json/list`, 4_000);
      return Array.isArray(targets) && !targets.some((target) => target?.id === targetId)
        ? true
        : null;
    },
    10_000,
    "Service worker target did not go away"
  );
}

async function waitForServiceWorkerTarget(timeoutMs) {
  return waitFor(
    async () => {
      const targets = await fetchJson(`${baseUrl}/json/list`, 4_000);
      return Array.isArray(targets)
        ? (targets.find(
            (target) =>
              target?.type === "service_worker" &&
              typeof target?.url === "string" &&
              target.url.startsWith("chrome-extension://") &&
              target.url.endsWith("/sw.js")
          ) ?? null)
        : null;
    },
    timeoutMs,
    "Extension service worker target not found"
  );
}

async function startFixtureServer() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><html><head><title>sw restart fixture</title></head>" +
        "<body><h1>WebBlackbox SW restart fixture</h1><button id='b'>Click</button></body></html>"
    );
  });
  state.server = server;
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  return `http://127.0.0.1:${address.port}/`;
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
    "--disable-default-apps",
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "--enable-logging=stderr",
    "--v=0",
    "about:blank"
  ];

  if (headless) {
    args.unshift("--headless=new");
  }

  const proc = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  const logStream = createWriteStream(chromeLogPath, { flags: "a" });
  proc.stdout?.pipe(logStream);
  proc.stderr?.pipe(logStream);
  state.chromeProcess = proc;
  state.logStream = logStream;
}

async function resolveChromeBinary(candidates) {
  for (const candidate of candidates) {
    const trimmed = typeof candidate === "string" ? candidate.trim() : "";

    if (!trimmed) {
      continue;
    }

    const resolved = isAbsolute(trimmed)
      ? trimmed
      : spawnSync("which", [trimmed], { encoding: "utf8" }).stdout.trim().split("\n")[0];

    if (!resolved) {
      continue;
    }

    try {
      await access(resolved, constants.X_OK);
      return resolved;
    } catch {
      continue;
    }
  }

  throw new Error("Chrome binary not found. Set WB_E2E_CHROME_BIN.");
}

async function openTarget(url) {
  const target = await fetchJson(`${baseUrl}/json/new?${encodeURIComponent(url)}`, 6_000, {
    method: "PUT"
  });
  assert(target?.webSocketDebuggerUrl, `Failed to open target: ${url}`, target);
  return target;
}

async function connect(wsUrl) {
  const client = new CdpClient(wsUrl);
  await client.connect();
  state.clients.push(client);
  return client;
}

function assert(condition, message, details) {
  if (!condition) {
    const suffix = details === undefined ? "" : ` | details=${JSON.stringify(details)}`;
    throw new Error(`${message}${suffix}`);
  }
}

async function waitFor(fn, timeoutMs, timeoutMessage, intervalMs = 250) {
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

    await sleep(intervalMs);
  }

  throw new Error(
    lastError instanceof Error ? `${timeoutMessage}: ${lastError.message}` : timeoutMessage
  );
}

async function fetchJson(url, timeoutMs, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.json();
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function cleanup() {
  for (const client of state.clients.splice(0)) {
    client.close();
  }

  if (state.chromeProcess && !state.chromeProcess.killed) {
    state.chromeProcess.kill("SIGTERM");
    await sleep(500);

    if (state.chromeProcess.exitCode === null) {
      state.chromeProcess.kill("SIGKILL");
    }
  }

  state.chromeProcess = null;

  if (state.server) {
    await new Promise((resolveClose) => state.server.close(resolveClose));
    state.server = null;
  }

  if (state.logStream) {
    await new Promise((resolveEnd) => state.logStream.end(resolveEnd));
    state.logStream = null;
  }
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.socket = null;
    this.sequence = 0;
    this.pending = new Map();
  }

  async connect() {
    await new Promise((resolveConnect, rejectConnect) => {
      const socket = new WebSocket(this.wsUrl);
      this.socket = socket;
      socket.addEventListener("open", () => resolveConnect());
      socket.addEventListener("error", () =>
        rejectConnect(new Error(`Failed to open WebSocket: ${this.wsUrl}`))
      );
      socket.addEventListener("close", () => {
        for (const pending of this.pending.values()) {
          pending.reject(new Error("CDP socket closed"));
        }
        this.pending.clear();
      });
      socket.addEventListener("message", (event) => {
        const payload = JSON.parse(String(event.data));
        const pending = typeof payload.id === "number" ? this.pending.get(payload.id) : undefined;

        if (!pending) {
          return;
        }

        this.pending.delete(payload.id);

        if (payload.error) {
          pending.reject(new Error(payload.error.message ?? JSON.stringify(payload.error)));
          return;
        }

        pending.resolve(payload.result);
      });
    });
  }

  send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP socket is not open"));
    }

    const id = ++this.sequence;

    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
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
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          "Runtime.evaluate failed"
      );
    }

    return result?.result?.value;
  }

  close() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close();
    }
  }
}
