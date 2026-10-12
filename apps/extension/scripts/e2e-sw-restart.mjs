#!/usr/bin/env node

// Regression e2e for MV3 service-worker restarts:
// 1. record + stop a lite session (the offscreen document stays alive),
// 2. plant an orphaned session in the pipeline IndexedDB,
// 3. start another lite session and terminate the service worker through CDP
//    (`Target.closeTarget`) while it records,
// 4. the recording the worker left running is listed as interrupted and exports a valid
//    archive that the built player-sdk opens: its events and its interruption are there,
// 5. start a new session — it must succeed (the offscreen pipeline is reachable again),
//    export it, and the orphaned IndexedDB session must have been swept.

import { spawn, spawnSync } from "node:child_process";
import { constants, createWriteStream } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openArchive } from "./lib/archive-checks.mjs";
import { isExtensionServiceWorkerTarget, requireExtensionId } from "./lib/devtools-targets.mjs";
import { DEFAULT_EXTENSION_DIR, EXTENSION_FILES } from "./lib/extension-paths.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(root, "..");
const workspaceRoot = resolve(appRoot, "../..");
const playerSdkEntry = resolve(workspaceRoot, "packages/player-sdk/dist/index.js");
const exportPassphrase = "webblackbox-e2e-passphrase";
// Logged while the interrupted session records; the default policy keeps console metadata only.
const interruptedMarker = "sw-restart-e2e-interrupted";
/** Shortest wait between the marker and the worker's stop (page clock ~ test clock). */
const MARKER_DELIVERY_FLOOR_MS = 4_000;

const extensionDir = process.env.WB_E2E_EXTENSION_DIR ?? DEFAULT_EXTENSION_DIR;
/** Set once the build is known; Chrome's own extensions run service workers too. */
let expectedExtensionId = null;
const remotePort = Number(process.env.WB_E2E_REMOTE_PORT ?? "9233");
const headless = (process.env.WB_E2E_HEADLESS ?? "1") !== "0";
const profileDir =
  process.env.WB_E2E_PROFILE_DIR ?? `/tmp/webblackbox-ext-sw-restart-profile-${Date.now()}`;
const chromeLogPath = process.env.WB_E2E_LOG ?? `/tmp/webblackbox-ext-sw-restart-${Date.now()}.log`;
const baseUrl = `http://127.0.0.1:${remotePort}`;
const pipelineDbName = "webblackbox-flight-recorder";
const downloadDir = process.env.WB_E2E_DOWNLOAD_DIR ?? `${profileDir}-downloads`;
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
  await access(playerSdkEntry, constants.R_OK);
  const chromeBinary = await resolveChromeBinary(chromeCandidates);
  const pageUrl = await startFixtureServer();

  await rm(profileDir, { recursive: true, force: true });
  await mkdir(profileDir, { recursive: true });
  await rm(downloadDir, { recursive: true, force: true });
  await mkdir(downloadDir, { recursive: true });
  startChrome(chromeBinary);

  const version = await waitFor(
    () => fetchJson(`${baseUrl}/json/version`, 4_000).then((v) => (v?.Browser ? v : null)),
    20_000,
    "Chrome DevTools endpoint not ready"
  );
  console.log(`Chrome: ${version.Browser}`);

  expectedExtensionId = await requireExtensionId(extensionDir);
  const swTarget = await waitForServiceWorkerTarget(20_000);
  const extensionId = expectedExtensionId;
  console.log(`Extension ID: ${extensionId}`);

  const browserClient = await connect(version.webSocketDebuggerUrl);
  await browserClient.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDir
  });
  const pageClient = await connect((await openTarget(pageUrl)).webSocketDebuggerUrl);
  const popupClient = await connect(
    (await openTarget(`chrome-extension://${extensionId}/${EXTENSION_FILES.popupPage}`))
      .webSocketDebuggerUrl
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

  const interrupted = await startRecording(popupClient, pageClient, pageUrl);
  const countedBeforeMarker = await readEventCount(popupClient, interrupted.sid);
  // Page clock: console text is stored redacted, so the archive is checked by event time.
  const markerLoggedAt = await pageClient.evaluate(
    `(() => { const at = Date.now(); console.info(${JSON.stringify(interruptedMarker)}); return at; })()`
  );
  await waitFor(
    async () =>
      (await readLiveCheckpointSids(popupClient)).includes(interrupted.sid) ? true : null,
    10_000,
    "The running recording was not checkpointed"
  );
  // The worker counted the marker and its pipeline batch (120 ms) reached the offscreen
  // document. Under load the lite page path alone can take over two seconds, hence the floor.
  await waitForSettledEventCount(popupClient, interrupted.sid, countedBeforeMarker);
  await sleep(Math.max(500, markerLoggedAt + MARKER_DELIVERY_FLOOR_MS - Date.now()));
  console.log("Interrupted session (recording at SW stop):", JSON.stringify(interrupted));

  await terminateServiceWorker(browserClient, swTarget.id);
  console.log("Service worker terminated.");

  const listed = await waitFor(
    async () => {
      const sessions = await requestSessionList(popupClient);
      const row = sessions.find((session) => session?.sid === interrupted.sid);
      return row && row.active === false && row.interruption ? row : null;
    },
    20_000,
    "The recording the worker left running is not listed as interrupted"
  );
  assert(
    listed.interruption.reason === "service-worker-restart",
    "Interrupted session lists the wrong reason",
    listed
  );
  await waitFor(
    async () => {
      const text = await pageClient.evaluate(
        `document.querySelector('[data-webblackbox-indicator="true"]')?.textContent ?? null`
      );
      return text ? null : true;
    },
    10_000,
    "Recording indicator of the interrupted session did not clear"
  );
  console.log("Listed as interrupted:", JSON.stringify(listed.interruption));

  // The worker's start-up sweep has run (UI requests wait for it): the recording's data is kept.
  const storedBeforeExport = await listStoredSessionIds(popupClient);
  assert(
    storedBeforeExport.includes(interrupted.sid),
    "The interrupted session must survive the orphan sweep",
    { storedBeforeExport, interrupted }
  );

  await checkInterruptedArchive(popupClient, interrupted.sid, markerLoggedAt);

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
  const { sid, tabId } = await startRecording(popupClient, pageClient, pageUrl);

  const stop = await popupClient.evaluate(`
    (async () => {
      const response = await chrome.runtime.sendMessage({ kind: 'ui.stop', tabId: ${tabId} });
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

  return { sid, tabId };
}

async function startRecording(popupClient, pageClient, pageUrl) {
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

  return { sid, tabId: start.tabId };
}

/** The session list a UI page gets (it also wakes the worker). */
async function requestSessionList(popupClient) {
  return popupClient.evaluate(`
    (async () => {
      try {
        const response = await chrome.runtime.sendMessage({ kind: 'ui.request-session-list' });
        return Array.isArray(response?.sessions) ? response.sessions : [];
      } catch {
        return [];
      }
    })()
  `);
}

async function readEventCount(popupClient, sid) {
  const sessions = await requestSessionList(popupClient);
  const count = sessions.find((session) => session?.sid === sid)?.eventCount;
  return typeof count === "number" ? count : 0;
}

/** Waits until the worker counted new events of `sid` and the count stopped moving. */
async function waitForSettledEventCount(popupClient, sid, countedBefore) {
  let previous = -1;

  await waitFor(
    async () => {
      const count = await readEventCount(popupClient, sid);
      const settled = count > countedBefore && count === previous;
      previous = count;
      return settled ? true : null;
    },
    15_000,
    "The worker did not count the events logged before the stop",
    500
  );
}

async function readLiveCheckpointSids(popupClient) {
  return popupClient.evaluate(`
    (async () => {
      const store = await chrome.storage.session.get('webblackbox.atRest.liveSessions');
      const rows = store['webblackbox.atRest.liveSessions'];
      return Array.isArray(rows) ? rows.map((row) => row?.sid) : [];
    })()
  `);
}

/** Exports the interrupted recording and opens the archive with the built player-sdk. */
async function checkInterruptedArchive(popupClient, sid, markerLoggedAt) {
  const exportStartedAt = Date.now();
  const exported = await exportSession(popupClient, sid);
  assert(exported?.ok === true, "Export of the interrupted session failed", exported);

  let seenDownloads = [];
  const download = await waitFor(
    async () => {
      const rows = await popupClient.evaluate(`
        (async () => {
          const rows = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 20 });
          return rows.map((row) => ({
            filename: row.filename,
            state: row.state,
            startTime: row.startTime
          }));
        })()
      `);
      seenDownloads = rows;
      // Downloads made through CDP's download behavior can be named by GUID: the newest one
      // started after the export is the archive.
      const row = rows.find(
        (item) =>
          typeof item.filename === "string" &&
          (item.filename.includes(sid) || /\.(webblackbox|zip)$/.test(item.filename)) &&
          Date.parse(item.startTime) >= exportStartedAt - 4_000
      );
      return row?.state === "complete" ? row : null;
    },
    30_000,
    "The interrupted session's archive was not downloaded"
  ).catch((error) => {
    console.error(
      "Downloads seen:",
      JSON.stringify(seenDownloads),
      "export:",
      JSON.stringify(exported)
    );
    throw error;
  });
  const player = await openArchive({
    archivePath: download.filename,
    passphrase: exportPassphrase,
    playerSdkEntry
  });
  const report = player.getCaptureCompleteness().export;
  const types = new Set(player.events.map((event) => event.type));
  // Logged just before the worker died: archived only if the pipeline tail was saved.
  const markerFound =
    types.has("meta.config") &&
    player.events.some((event) => event.type === "console.entry" && event.t >= markerLoggedAt);

  assert(
    report.interruption?.reason === "service-worker-restart",
    "The interrupted session's archive does not record its interruption",
    report
  );
  assert(
    report.recorded && !report.truncations.some((row) => row.reason !== "screenshots-excluded"),
    "The interrupted session's archive left recorded events out",
    report
  );
  assert(
    markerFound,
    "The interrupted session's archive lacks the events recorded before the stop",
    {
      types: [...types],
      markerLoggedAt,
      consoleTimes: player.events
        .filter((event) => event.type === "console.entry")
        .map((event) => event.t)
    }
  );
  console.log(
    "Interrupted archive:",
    JSON.stringify({
      file: download.filename,
      events: player.events.length,
      export: { storedEvents: report.storedEvents, interruption: report.interruption }
    })
  );
}

async function exportSession(popupClient, sid) {
  return popupClient.evaluate(`
    (async () => {
      const response = await chrome.runtime.sendMessage({
        kind: 'ui.export',
        sid: ${JSON.stringify(sid)},
        passphrase: ${JSON.stringify(exportPassphrase)}
      });
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
        ? (targets.find((target) => isExtensionServiceWorkerTarget(target, expectedExtensionId)) ??
            null)
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
