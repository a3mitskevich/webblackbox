#!/usr/bin/env node

// Regression e2e for CDP tab isolation: two Full recordings run at the same time must not see each
// other's CDP events (network, console, child targets). Every session attaches chrome.debugger to its
// own tab, but chrome.debugger.onEvent is global to the extension, so the routing has to keep each
// event with the recording of the tab it came from.
//
// Scenario "cross-site": tab A (alpha.test) and tab B (beta.test). Tab A also hosts a cross-site
// iframe (an out-of-process child target), a dedicated worker (a child target) and opens a popup.
// The iframe and the worker belong to tab A's recording. The popup is a separate tab of type `page`,
// which the Full auto-attach filter does not attach, so by design neither recording contains it.
// Scenario "same-site": two tabs of the same site.
//
// Each archive is exported encrypted and opened with the built player-sdk. Its own markers must be
// there (positive control) and no other tab's markers may be.

import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

import { CdpClient, closeClient } from "./lib/cdp-client.mjs";
import {
  CHROME_LAUNCH_PROFILES,
  ensureExtensionBuildReady,
  launchChromeWithRetry,
  resolveChromeBinary,
  terminateChromeProcess
} from "./lib/chrome-launcher.mjs";
import {
  closeTarget,
  isLikelyExtensionId,
  listHttpTargets,
  openTarget,
  resolvePreferredExtensionId
} from "./lib/devtools-targets.mjs";
import {
  assert,
  formatErrorMessage,
  printChromeConsoleTail,
  readPositiveInteger,
  sleep,
  waitFor
} from "./lib/e2e-utils.mjs";
import {
  readRuntimeSessions,
  waitForIndicatorGone,
  waitForIndicatorText,
  waitForPopupRuntimeReady
} from "./lib/extension-ui.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(root, "..");
const workspaceRoot = resolve(extensionRoot, "..", "..");

const extensionDir = process.env.WB_E2E_EXTENSION_DIR ?? resolve(extensionRoot, "build");
const playerSdkEntry = resolve(workspaceRoot, "packages/player-sdk/dist/index.js");
const remotePort = Number(process.env.WB_E2E_REMOTE_PORT ?? "9235");
const headless = (process.env.WB_E2E_HEADLESS ?? "1") !== "0";
const runId = Date.now();
const profileDir =
  process.env.WB_E2E_PROFILE_DIR ?? `/tmp/webblackbox-ext-isolation-profile-${runId}`;
const downloadDir =
  process.env.WB_E2E_DOWNLOAD_DIR ?? `/tmp/webblackbox-ext-isolation-downloads-${runId}`;
const chromeLogPath = process.env.WB_E2E_LOG ?? `/tmp/webblackbox-ext-isolation-${runId}.log`;
const cdpClientOptions = {
  commandTimeoutMs: readPositiveInteger(process.env.WB_E2E_CDP_COMMAND_TIMEOUT_MS, 15_000)
};
// Rounds are labelled a, b, c, ... in the markers, so at most 26.
const activityRounds = Math.min(readPositiveInteger(process.env.WB_E2E_ISOLATION_ROUNDS, 6), 26);
const exportPassphrase = process.env.WB_E2E_EXPORT_PASSPHRASE ?? "webblackbox-e2e-passphrase";

// Two registrable domains mapped to the loopback fixture server: different sites, so the iframe of
// site B inside site A runs out of process and reaches the recorder as an auto-attached child target.
const SITE_A = "alpha.test";
const SITE_B = "beta.test";
const HOST_RESOLVER_RULES = `--host-resolver-rules=MAP ${SITE_A} 127.0.0.1,MAP ${SITE_B} 127.0.0.1`;

const PAGE_READY_TIMEOUT_MS = 20_000;
const INDICATOR_TIMEOUT_MS = 25_000;
const SERVER_HITS_TIMEOUT_MS = 20_000;
const EXPORT_TIMEOUT_MS = 90_000;
const CAPTURE_SETTLE_MS = 1_500;
const POLL_INTERVAL_MS = 250;
const DOWNLOAD_CLOCK_SKEW_MS = 2_000;
const FAILURE_CONSOLE_TAIL_LINES = 60;
const EXPORT_POLICY = {
  includeScreenshots: false,
  includeScreenRecordings: false,
  maxArchiveBytes: 100 * 1024 * 1024,
  recentWindowMs: 20 * 60 * 1000
};

const state = {
  chromeProcess: null,
  logStream: null,
  baseUrl: null,
  server: null,
  clients: [],
  openedTargetIds: []
};

main().catch(async (error) => {
  console.error("CDP tab isolation e2e failed:", formatErrorMessage(error));
  console.error(`Chrome log: ${chromeLogPath}`);
  await printChromeConsoleTail(chromeLogPath, FAILURE_CONSOLE_TAIL_LINES);
  await cleanup();
  process.exit(1);
});

async function main() {
  await ensureExtensionBuildReady(extensionDir);
  await readFile(playerSdkEntry).catch(() => {
    throw new Error(`player-sdk is not built: ${playerSdkEntry}. Run pnpm build first.`);
  });

  const chromeBinary = await resolveChromeBinary();
  const extensionId = await resolvePreferredExtensionId(extensionDir);
  assert(isLikelyExtensionId(extensionId), "Failed to resolve extension id from manifest key.", {
    extensionDir
  });

  const fixture = await startFixtureServer();
  state.server = fixture.server;

  const chrome = await launchChromeWithRetry(chromeBinary, {
    extensionDir,
    profileDir,
    remotePort,
    headless,
    logPath: chromeLogPath,
    chrome: {
      ...CHROME_LAUNCH_PROFILES.fullchain,
      extraArgs: [...CHROME_LAUNCH_PROFILES.fullchain.extraArgs, HOST_RESOLVER_RULES]
    },
    attempts: 2,
    readyTimeoutMs: 25_000
  });
  state.chromeProcess = chrome.proc;
  state.logStream = chrome.logStream;
  state.baseUrl = chrome.baseUrl;
  console.log(`Chrome: ${chrome.version.Browser}`);
  console.log(`Extension ID: ${extensionId}`);

  const browserClient = await connectClient(chrome.version.webSocketDebuggerUrl);
  await browserClient.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDir,
    eventsEnabled: true
  });

  const controlTarget = await openTarget(
    state.baseUrl,
    `chrome-extension://${extensionId}/popup.html`
  );
  state.openedTargetIds.push(controlTarget.id);
  const control = await connectClient(controlTarget.webSocketDebuggerUrl);
  await control.send("Runtime.enable");
  await waitForPopupRuntimeReady(control, 20_000);

  const configured = await configureFullCaptureOptions(control);
  assert(configured?.ok === true, "Failed to configure Full capture options.", configured);

  const port = fixture.port;
  const crossSite = await runIsolationScenario(control, fixture, "cross-site", [
    createTabSpec("a", `http://${SITE_A}:${port}`, {
      childFrameOrigin: `http://${SITE_B}:${port}`
    }),
    createTabSpec("b", `http://${SITE_B}:${port}`)
  ]);
  const sameSite = await runIsolationScenario(control, fixture, "same-site", [
    createTabSpec("c", `http://${SITE_A}:${port}`),
    createTabSpec("d", `http://${SITE_A}:${port}`)
  ]);

  console.log(JSON.stringify({ crossSite, sameSite }, null, 2));
  console.log("CDP tab isolation e2e passed.");
  await cleanup();
}

function createTabSpec(role, origin, options = {}) {
  const marker = createMarker(role);
  const children = options.childFrameOrigin
    ? {
        frameMarker: createMarker(`${role}frame`),
        workerMarker: createMarker(`${role}worker`),
        popupMarker: createMarker(`${role}popup`),
        frameOrigin: options.childFrameOrigin
      }
    : null;

  return { role, origin, marker, children, pageUrl: buildPageUrl(origin, marker, children) };
}

// Archives keep URLs route-templated: a path segment with digits, hex-only or a sensitive word
// becomes `:id`/`:token`. Markers therefore use only letters outside a-f and without vowels.
const MARKER_ALPHABET = "ghkmnpqrsvxz";
const MARKER_RANDOM_LENGTH = 12;

function createMarker(role) {
  const random = [...randomBytes(MARKER_RANDOM_LENGTH)]
    .map((byte) => MARKER_ALPHABET[byte % MARKER_ALPHABET.length])
    .join("");
  return `wbiso${role}${random}`;
}

function roundLabel(round) {
  return String.fromCharCode("a".charCodeAt(0) + round);
}

function buildPageUrl(origin, marker, children) {
  if (!children) {
    return `${origin}/page/${marker}`;
  }

  const params = new URLSearchParams({
    frame: `${children.frameOrigin}/frame/${children.frameMarker}`,
    worker: children.workerMarker,
    popup: `${origin}/popup/${children.popupMarker}`
  });
  return `${origin}/page/${marker}?${params.toString()}`;
}

/** Markers whose network activity the tab's own recording must contain. */
function ownActivityMarkers(tab) {
  return tab.children
    ? [tab.marker, tab.children.frameMarker, tab.children.workerMarker]
    : [tab.marker];
}

/** Every marker the tab produces, including its popup, which no other recording may contain. */
function allMarkers(tab) {
  return tab.children ? [...ownActivityMarkers(tab), tab.children.popupMarker] : [tab.marker];
}

async function runIsolationScenario(control, fixture, name, tabs) {
  console.log(`[${name}] opening ${tabs.length} tabs`);
  const pages = [];

  for (const tab of tabs) {
    const target = await openTarget(state.baseUrl, tab.pageUrl);
    state.openedTargetIds.push(target.id);
    const client = await connectClient(target.webSocketDebuggerUrl);
    await client.send("Runtime.enable");
    pages.push({ tab, client, targetId: target.id });
  }

  for (const page of pages) {
    await waitForPageReady(page);
    page.tabId = await resolveTabId(control, page.tab.pageUrl);
  }

  for (const page of pages) {
    const started = await sendRuntimeMessage(control, {
      kind: "ui.start",
      tabId: page.tabId,
      mode: "full",
      visualCapture: "none"
    });
    assert(started?.ok === true, `[${name}] failed to start Full session`, started);
    await waitForIndicatorText(page.client, "REC full", INDICATOR_TIMEOUT_MS);
  }

  const sessions = await readRuntimeSessions(control);

  for (const page of pages) {
    page.sid = sessions.find((row) => row?.tabId === page.tabId)?.sid;
    assert(typeof page.sid === "string", `[${name}] no active session for tab ${page.tab.role}`, {
      sessions
    });
  }

  // Interleave activity across the tabs so both recordings are live while the other tab is busy.
  for (let round = 0; round < activityRounds; round += 1) {
    for (const page of pages) {
      const emitted = await page.client.evaluate(`window.__wbIso.emit(${round})`);
      assert(emitted === true, `[${name}] activity failed in tab ${page.tab.role}`, emitted);
    }
  }

  for (const page of pages) {
    if (page.tab.children) {
      const opened = await page.client.evaluate(`window.__wbIso.openPopup()`);
      assert(opened === true, `[${name}] popup did not open from tab ${page.tab.role}`, opened);
    }
  }

  const expectedHits = tabs.flatMap((tab) =>
    allMarkers(tab).map((marker) => `${marker}-net-${roundLabel(activityRounds - 1)}`)
  );
  await waitFor(
    () => (expectedHits.every((hit) => fixture.hits.has(hit)) ? true : null),
    SERVER_HITS_TIMEOUT_MS,
    POLL_INTERVAL_MS,
    () =>
      `[${name}] fixture server did not see all marker requests: missing ${expectedHits
        .filter((hit) => !fixture.hits.has(hit))
        .join(", ")}`
  );
  await sleep(CAPTURE_SETTLE_MS);

  for (const page of pages) {
    const stopped = await sendRuntimeMessage(control, { kind: "ui.stop", tabId: page.tabId });
    assert(stopped?.ok === true, `[${name}] failed to stop tab ${page.tab.role}`, stopped);
    await waitForIndicatorGone(page.client, INDICATOR_TIMEOUT_MS);
  }

  await closePopups(tabs);

  const archives = [];

  for (const page of pages) {
    archives.push({ page, events: await exportAndOpenArchive(control, page.sid) });
  }

  const summary = archives.map((archive) =>
    verifyArchiveIsolation(
      name,
      archive,
      tabs.filter((tab) => tab !== archive.page.tab)
    )
  );

  for (const page of pages) {
    await closeClient(page.client);
    await closeTarget(state.baseUrl, page.targetId);
  }

  return summary;
}

function verifyArchiveIsolation(name, archive, foreignTabs) {
  const { tab, sid } = archive.page;
  const serialized = archive.events.map((event) => ({
    type: event?.type,
    json: JSON.stringify(event)
  }));
  const matching = (fragment) => serialized.filter((entry) => entry.json.includes(fragment));
  const ownCounts = {};

  for (const marker of ownActivityMarkers(tab)) {
    const hits = matching(`${marker}-net-`);
    ownCounts[marker] = hits.length;
    assert(
      hits.length > 0,
      `[${name}] tab ${tab.role} archive is missing its own network activity (${marker})`,
      {
        sid,
        types: summarizeTypes(serialized),
        requests: archive.events
          .filter((event) => event?.type === "network.request")
          .slice(0, 8)
          .map((event) => event?.data?.request?.url ?? event?.data?.url ?? event?.data)
      }
    );
  }

  if (tab.children) {
    // The popup is a separate tab; the opener's recording does not follow it (current design).
    const popupActivity = [
      ...matching(`${tab.children.popupMarker}-net-`),
      ...matching(`${tab.children.popupMarker}-console-`)
    ];
    assert(
      popupActivity.length === 0,
      `[${name}] tab ${tab.role} archive unexpectedly contains its popup's activity`,
      { sid, types: summarizeTypes(popupActivity) }
    );
  }

  const leaks = foreignTabs.flatMap((foreign) =>
    allMarkers(foreign).flatMap((marker) => {
      const hits = matching(marker);
      return hits.length > 0
        ? [{ from: foreign.role, marker, count: hits.length, types: summarizeTypes(hits) }]
        : [];
    })
  );
  assert(
    leaks.length === 0,
    `[${name}] tab ${tab.role} archive contains events of another tab (CDP tab isolation leak)`,
    { sid, leaks }
  );

  return { scenario: name, tab: tab.role, sid, events: archive.events.length, own: ownCounts };
}

function summarizeTypes(entries) {
  const counts = {};

  for (const entry of entries) {
    const type = String(entry.type);
    counts[type] = (counts[type] ?? 0) + 1;
  }

  return counts;
}

async function waitForPageReady(page) {
  const expression = page.tab.children
    ? `window.__wbIso?.ready === true && window.__wbIso.frameReady === true && window.__wbIso.workerReady === true`
    : `window.__wbIso?.ready === true`;

  await waitFor(
    async () => ((await page.client.evaluate(expression)) === true ? true : null),
    PAGE_READY_TIMEOUT_MS,
    POLL_INTERVAL_MS,
    `Fixture page ${page.tab.role} did not become ready`
  );
}

async function resolveTabId(control, pageUrl) {
  const tabId = await control.evaluate(`
    (async () => {
      const tabs = await chrome.tabs.query({});
      const match = tabs.find((tab) => tab.url === ${JSON.stringify(pageUrl)});
      return typeof match?.id === 'number' ? match.id : null;
    })()
  `);
  assert(typeof tabId === "number", "Failed to resolve the fixture tab id", { pageUrl });
  return tabId;
}

async function sendRuntimeMessage(control, message, timeoutMs = undefined) {
  return control.evaluate(
    `
    (async () => {
      try {
        const response = await chrome.runtime.sendMessage(${JSON.stringify(message)});
        if (response && typeof response === 'object' && response.ok === false) {
          return { ok: false, response };
        }
        return { ok: true, response: response ?? null };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    })()
  `,
    { timeoutMs }
  );
}

async function closePopups(tabs) {
  const popupMarkers = tabs.flatMap((tab) => (tab.children ? [tab.children.popupMarker] : []));

  if (popupMarkers.length === 0) {
    return;
  }

  const targets = await listHttpTargets(state.baseUrl).catch(() => []);

  for (const target of targets) {
    const url = typeof target?.url === "string" ? target.url : "";

    if (popupMarkers.some((marker) => url.includes(marker))) {
      await closeTarget(state.baseUrl, target.id);
    }
  }
}

async function exportAndOpenArchive(control, sid) {
  // Exports run one at a time, so the newest download started after this request is this archive.
  const requestedAtMs = Date.now();
  const exported = await sendRuntimeMessage(
    control,
    { kind: "ui.export", sid, passphrase: exportPassphrase, saveAs: false, policy: EXPORT_POLICY },
    EXPORT_TIMEOUT_MS
  );
  assert(exported?.ok === true, "Export failed", { sid, exported });

  const archivePath = await waitFor(
    () => findCompletedArchiveDownload(control, requestedAtMs),
    EXPORT_TIMEOUT_MS,
    POLL_INTERVAL_MS,
    `Exported archive for ${sid} did not finish downloading`
  );
  const { WebBlackboxPlayer } = await import(pathToFileURL(playerSdkEntry).href);
  const player = await WebBlackboxPlayer.open(new Uint8Array(await readFile(archivePath)), {
    passphrase: exportPassphrase
  });
  const events = player.query({});
  const foreignSids = [...new Set(events.map((event) => event?.sid))].filter(
    (eventSid) => eventSid !== sid
  );
  assert(
    events.length > 0 && foreignSids.length === 0,
    "Downloaded archive does not belong to the exported session",
    { sid, foreignSids, events: events.length, archivePath }
  );
  return events;
}

async function findCompletedArchiveDownload(control, requestedAtMs) {
  const download = await control.evaluate(`
    (async () => {
      const rows = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 20 });
      const row = rows.find(
        (item) =>
          typeof item.filename === 'string' &&
          /\\.(webblackbox|zip)$/u.test(item.filename) &&
          Date.parse(item.startTime) >= ${requestedAtMs} - ${DOWNLOAD_CLOCK_SKEW_MS}
      );
      return row ? { filename: row.filename, state: row.state, error: row.error ?? null } : null;
    })()
  `);

  if (!download || download.state === "in_progress") {
    return null;
  }

  assert(download.state === "complete", "Archive download failed", download);
  return download.filename;
}

async function configureFullCaptureOptions(control) {
  return control.evaluate(`
    (async () => {
      const capturePolicy = {
        schemaVersion: 2,
        mode: 'lab',
        captureContext: 'synthetic',
        captureContextEvidenceRef: 'synthetic:e2e-cdp-tab-isolation',
        consent: {
          id: 'webblackbox-e2e-consent',
          provenance: 'self-recording',
          purpose: 'qa',
          grantedBy: 'webblackbox-e2e',
          grantedAt: new Date().toISOString()
        },
        unmaskPolicySource: 'extension-managed',
        scope: {
          tabId: 0,
          origin: '',
          allowedOrigins: [],
          deniedOrigins: [],
          includeSubframes: true,
          stopOnOriginChange: true,
          excludedUrlPatterns: []
        },
        categories: {
          actions: 'allow',
          inputs: 'masked',
          dom: 'allow',
          screenshots: 'off',
          screenRecordings: 'off',
          console: 'allow',
          network: 'body-allowlist',
          storage: 'allow',
          indexedDb: 'names-only',
          cookies: 'names-only',
          cdp: 'full',
          heapProfiles: 'off'
        },
        encryption: {
          localAtRest: 'required',
          archive: 'required',
          archiveKeyEnvelope: 'passphrase'
        },
        retention: { localTtlMs: 24 * 60 * 60 * 1000 }
      };

      await chrome.storage.local.set({
        'webblackbox.options': {
          optionsVersion: 1,
          mode: 'full',
          freezeOnNetworkFailure: false,
          freezeOnLongTaskSpike: false,
          sampling: {
            mousemoveHz: 20,
            scrollHz: 15,
            domFlushMs: 100,
            screenshotIdleMs: 0,
            snapshotIntervalMs: 1000,
            actionWindowMs: 1500,
            bodyCaptureMaxBytes: 65536
          },
          capturePolicy
        }
      });

      return { ok: true };
    })()
  `);
}

async function startFixtureServer() {
  const hits = new Set();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    const [, kind = "", name = ""] = url.pathname.split("/");

    if (kind === "api" && url.pathname.startsWith("/api/mark/")) {
      const hit = url.pathname.slice("/api/mark/".length);
      hits.add(hit);
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, hit }));
      return;
    }

    if (kind === "worker" && name.endsWith(".js")) {
      response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      response.end(buildWorkerScript(name.slice(0, -".js".length)));
      return;
    }

    if (kind === "page" || kind === "frame" || kind === "popup") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(buildFixtureHtml(kind, name));
      return;
    }

    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });

  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return { server, port: server.address().port, hits };
}

/** Shared emitter: a console line, a DOM node and a network request, each carrying the marker. */
const EMIT_SOURCE = `
  async function emitMarker(marker, round) {
    const label = String.fromCharCode(97 + round);
    console.log(marker + '-console-' + label);
    if (typeof document === 'object') {
      const node = document.createElement('p');
      node.textContent = marker + '-dom-' + label;
      document.body.append(node);
    }
    const response = await fetch('/api/mark/' + marker + '-net-' + label, { cache: 'no-store' });
    return response.ok;
  }
`;

function buildWorkerScript(marker) {
  return `${EMIT_SOURCE}
    self.onmessage = async (event) => {
      const ok = await emitMarker(${JSON.stringify(marker)}, event.data.round).catch(() => false);
      self.postMessage({ round: event.data.round, ok });
    };
    self.postMessage({ ready: true });
  `;
}

function buildFixtureHtml(kind, marker) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${kind} ${marker}</title></head>
<body><h1>CDP tab isolation ${kind}</h1><script>
${EMIT_SOURCE}
const marker = ${JSON.stringify(marker)};
${kind === "page" ? PAGE_SCRIPT : CHILD_SCRIPT}
</script></body></html>`;
}

// The iframe emits on request from its parent; the popup emits on its own once it loads.
const CHILD_SCRIPT = `
  window.addEventListener('message', async (event) => {
    if (typeof event.data?.round !== 'number') return;
    const ok = await emitMarker(marker, event.data.round).catch(() => false);
    event.source?.postMessage({ frameRound: event.data.round, ok }, '*');
  });
  if (window.opener) {
    (async () => {
      for (let round = 0; round < ${activityRounds}; round += 1) {
        await emitMarker(marker, round).catch(() => false);
      }
    })();
  } else if (window.parent !== window) {
    window.parent.postMessage({ frameReady: true }, '*');
  }
`;

const PAGE_SCRIPT = `
  const params = new URLSearchParams(location.search);
  const state = { ready: false, frameReady: false, workerReady: false };
  const pending = new Map();
  let frame = null;
  let worker = null;

  const waitReply = (key) => new Promise((resolve) => pending.set(key, resolve));
  const settle = (key, ok) => { pending.get(key)?.(ok); pending.delete(key); };

  window.addEventListener('message', (event) => {
    if (event.data?.frameReady) state.frameReady = true;
    if (typeof event.data?.frameRound === 'number') settle('frame-' + event.data.frameRound, event.data.ok);
  });

  if (params.get('frame')) {
    frame = document.createElement('iframe');
    frame.src = params.get('frame');
    document.body.append(frame);
  }

  if (params.get('worker')) {
    worker = new Worker('/worker/' + params.get('worker') + '.js');
    worker.onmessage = (event) => {
      if (event.data?.ready) state.workerReady = true;
      if (typeof event.data?.round === 'number') settle('worker-' + event.data.round, event.data.ok);
    };
  }

  window.__wbIso = Object.assign(state, {
    async emit(round) {
      const results = [await emitMarker(marker, round)];
      if (frame) {
        const reply = waitReply('frame-' + round);
        frame.contentWindow.postMessage({ round }, '*');
        results.push(await reply);
      }
      if (worker) {
        const reply = waitReply('worker-' + round);
        worker.postMessage({ round });
        results.push(await reply);
      }
      return results.every((ok) => ok === true);
    },
    openPopup() {
      const url = params.get('popup');
      return Boolean(url && window.open(url, '_blank'));
    }
  });
  state.ready = true;
`;

async function connectClient(wsUrl) {
  assert(typeof wsUrl === "string" && wsUrl.length > 0, "Missing WebSocket debugger URL");
  const client = new CdpClient(wsUrl, cdpClientOptions);
  await client.connect();
  state.clients.push(client);
  return client;
}

async function cleanup() {
  for (const client of state.clients.splice(0)) {
    await closeClient(client);
  }

  if (state.baseUrl) {
    for (const targetId of state.openedTargetIds.splice(0)) {
      await closeTarget(state.baseUrl, targetId);
    }
  }

  const chromeProcess = state.chromeProcess;
  await terminateChromeProcess(chromeProcess);
  state.chromeProcess = null;

  if (state.logStream) {
    // Chrome's helper processes can outlive it and keep writing to the shared pipes.
    chromeProcess?.stdout?.unpipe(state.logStream);
    chromeProcess?.stderr?.unpipe(state.logStream);
    await new Promise((resolveEnd) => state.logStream.end(resolveEnd));
    state.logStream = null;
  }

  if (state.server) {
    await new Promise((resolveClose) => state.server.close(() => resolveClose()));
    state.server = null;
  }

  await rm(downloadDir, { recursive: true, force: true }).catch(() => undefined);
  await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
}
