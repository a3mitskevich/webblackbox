#!/usr/bin/env node

import { createServer } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CdpClient, closeClient } from "./lib/cdp-client.mjs";
import {
  CHROME_LAUNCH_PROFILES,
  ensureExtensionBuildReady,
  resolveChromeBinary,
  startChrome,
  waitForChromeReady
} from "./lib/chrome-launcher.mjs";
import {
  closeTarget,
  connectToDiscoveredTarget,
  isLikelyExtensionId,
  listTargets,
  openTarget,
  resolvePreferredExtensionId,
  waitForExtensionTarget
} from "./lib/devtools-targets.mjs";
import { assert, sleep, waitFor } from "./lib/e2e-utils.mjs";
import {
  deleteSessionFromPopup,
  readRuntimeSessions,
  waitForIndicatorGone,
  waitForIndicatorText,
  waitForPopupRuntimeReady
} from "./lib/extension-ui.mjs";
import {
  enablePortTrafficMeter,
  findBloatedBinaryTraffic,
  readPortTrafficStats,
  summarizePortTraffic
} from "./lib/port-traffic.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(root, "..");

const extensionDir = process.env.WB_E2E_EXTENSION_DIR ?? resolve(extensionRoot, "build");
const remotePort = Number(process.env.WB_E2E_REMOTE_PORT ?? "9234");
const headless = (process.env.WB_E2E_HEADLESS ?? "1") !== "0";
const profileDir =
  process.env.WB_E2E_PROFILE_DIR ?? `/tmp/webblackbox-ext-memory-profile-${Date.now()}`;
const chromeLogPath = process.env.WB_E2E_LOG ?? `/tmp/webblackbox-ext-memory-${Date.now()}.log`;
const baseUrl = `http://127.0.0.1:${remotePort}`;

const stressRequests = Number(process.env.WB_E2E_STRESS_REQUESTS ?? "240");
const stressConcurrency = Number(process.env.WB_E2E_STRESS_CONCURRENCY ?? "4");
const stressPauseMs = Number(process.env.WB_E2E_STRESS_PAUSE_MS ?? "10");
const stressPayloadBytes = Number(process.env.WB_E2E_STRESS_PAYLOAD_BYTES ?? "384");
const memorySampleIntervalMs = Number(process.env.WB_E2E_MEMORY_SAMPLE_MS ?? "4000");
const settleSamples = Number(process.env.WB_E2E_MEMORY_SETTLE_SAMPLES ?? "2");
const stressTimeoutMs = Number(process.env.WB_E2E_MEMORY_TIMEOUT_MS ?? "120000");
const offscreenFinalGrowthLimitMb = Number(process.env.WB_E2E_OFFSCREEN_FINAL_GROWTH_MB ?? "20");
const swFinalGrowthLimitMb = Number(process.env.WB_E2E_SW_FINAL_GROWTH_MB ?? "12");

const state = {
  chromeProcess: null,
  logStream: null,
  server: null,
  browserClient: null,
  popupClient: null,
  pageClient: null,
  swClient: null,
  offscreenClient: null,
  openedTargetIds: []
};

main().catch(async (error) => {
  console.error(
    "Full memory regression failed:",
    error instanceof Error ? error.message : String(error)
  );
  await cleanup();
  process.exit(1);
});

async function main() {
  await ensureExtensionBuildReady(extensionDir);
  const chromeBinary = await resolveChromeBinary();
  const extensionId = await resolvePreferredExtensionId(extensionDir);

  assert(isLikelyExtensionId(extensionId), "Failed to resolve extension id from manifest key.", {
    extensionDir
  });

  await rm(profileDir, { recursive: true, force: true });
  await mkdir(profileDir, { recursive: true });

  const server = await startStressServer();
  state.server = server.server;

  const stressUrl = `http://127.0.0.1:${server.port}/stress/`;

  const { proc, logStream } = startChrome(chromeBinary, {
    extensionDir,
    profileDir,
    remotePort,
    headless,
    logPath: chromeLogPath,
    ...CHROME_LAUNCH_PROFILES.fullMemory
  });

  state.chromeProcess = proc;
  state.logStream = logStream;

  const version = await waitForChromeReady(baseUrl, 25_000);
  console.log(`Chrome: ${version.Browser}`);
  console.log(`Extension ID: ${extensionId}`);

  const browserWsUrl =
    typeof version.webSocketDebuggerUrl === "string" ? version.webSocketDebuggerUrl : null;
  assert(browserWsUrl, "Browser websocket debugger URL is unavailable.", { version });

  const browserClient = new CdpClient(browserWsUrl);
  await browserClient.connect();
  state.browserClient = browserClient;

  const pageTarget = await openTarget(baseUrl, stressUrl);
  state.openedTargetIds.push(pageTarget.id);

  let swTarget = await waitForExtensionTarget(
    baseUrl,
    browserClient,
    (target) =>
      target.type === "service_worker" &&
      typeof target.url === "string" &&
      target.url === `chrome-extension://${extensionId}/sw.js`,
    8_000,
    "Extension service worker target not found"
  ).catch(() => null);

  const popupTarget = await openTarget(baseUrl, `chrome-extension://${extensionId}/popup.html`);
  state.openedTargetIds.push(popupTarget.id);

  if (!swTarget) {
    swTarget = await waitForExtensionTarget(
      baseUrl,
      browserClient,
      (target) =>
        target.type === "service_worker" &&
        typeof target.url === "string" &&
        target.url === `chrome-extension://${extensionId}/sw.js`,
      20_000,
      "Extension service worker target not found after popup warmup"
    );
  }

  const pageClient = new CdpClient(pageTarget.webSocketDebuggerUrl);
  const popupClient = new CdpClient(popupTarget.webSocketDebuggerUrl);
  await pageClient.connect();
  await popupClient.connect();
  state.pageClient = pageClient;
  state.popupClient = popupClient;

  await pageClient.send("Runtime.enable");
  await pageClient.send("Page.enable").catch(() => undefined);
  await popupClient.send("Runtime.enable");
  await waitForPopupRuntimeReady(popupClient, 20_000);

  const swClient = await connectToDiscoveredTarget(swTarget, browserClient);
  state.swClient = swClient;
  await swClient.send("Runtime.enable").catch(() => undefined);
  await enablePortTrafficMeter(swClient);

  const swExceptions = [];
  const offscreenExceptions = [];
  swClient.on("Runtime.exceptionThrown", (params) => {
    swExceptions.push({
      text: params?.exceptionDetails?.text ?? "unknown",
      line: params?.exceptionDetails?.lineNumber ?? null
    });
  });

  const start = await startSessionFromPopup(popupClient, "full", stressUrl);
  assert(start?.ok === true, "Failed to start full mode session.", start);

  const indicatorText = await waitForIndicatorText(pageClient, "REC full", 25_000);
  assert(typeof indicatorText === "string", "Full mode indicator did not appear.", {
    indicatorText
  });

  const sessionsAfterStart = await readRuntimeSessions(popupClient);
  assert(
    Array.isArray(sessionsAfterStart) && sessionsAfterStart.length === 1,
    "Expected exactly one active runtime session after start.",
    { sessionsAfterStart }
  );

  const active = sessionsAfterStart[0];
  assert(typeof active?.sid === "string" && active.sid.length > 0, "Missing active session sid.", {
    sessionsAfterStart
  });

  const offscreenTarget = await waitForExtensionTarget(
    baseUrl,
    browserClient,
    (target) =>
      typeof target.url === "string" &&
      target.url === `chrome-extension://${extensionId}/offscreen.html`,
    20_000,
    "Offscreen document target not found"
  );

  const offscreenClient = await connectToDiscoveredTarget(offscreenTarget, browserClient);
  state.offscreenClient = offscreenClient;
  await offscreenClient.send("Runtime.enable").catch(() => undefined);
  offscreenClient.on("Runtime.exceptionThrown", (params) => {
    offscreenExceptions.push({
      text: params?.exceptionDetails?.text ?? "unknown",
      line: params?.exceptionDetails?.lineNumber ?? null
    });
  });

  await Promise.allSettled([
    prepareHeapSampling(pageClient),
    prepareHeapSampling(swClient),
    prepareHeapSampling(offscreenClient)
  ]);

  const samples = [];
  const baseline = await collectMemorySample({
    sampleIndex: 0,
    pageClient,
    swClient,
    offscreenClient
  });
  samples.push(baseline);
  logSample(baseline);

  const stressSeed = Math.random().toString(36).slice(2);
  const startedStress = await startStressScenario(pageClient, {
    requests: stressRequests,
    concurrency: stressConcurrency,
    pauseMs: stressPauseMs,
    apiBaseUrl: `http://127.0.0.1:${server.port}/api/ping/`,
    seed: stressSeed
  });
  assert(startedStress?.ok === true, "Failed to start stress scenario.", startedStress);

  const deadline = Date.now() + stressTimeoutMs;
  let lastStressState = null;
  let sampleIndex = 1;

  while (Date.now() < deadline) {
    await sleep(memorySampleIntervalMs);
    const sample = await collectMemorySample({
      sampleIndex,
      pageClient,
      swClient,
      offscreenClient
    });
    samples.push(sample);
    logSample(sample);
    lastStressState = sample.stress;
    sampleIndex += 1;

    if (sample.stress?.done === true) {
      break;
    }
  }

  assert(lastStressState?.done === true, "Stress scenario timed out before completion.", {
    lastStressState,
    timeoutMs: stressTimeoutMs
  });
  assert(lastStressState?.failed !== true, "Stress scenario failed in page context.", {
    lastStressState
  });
  assert(lastStressState?.errors === 0, "Stress scenario reported fetch errors.", {
    lastStressState
  });
  assert(
    lastStressState?.count >= stressRequests,
    "Stress scenario completed too few iterations.",
    {
      expected: stressRequests,
      actual: lastStressState?.count
    }
  );

  for (let index = 0; index < settleSamples; index += 1) {
    await sleep(memorySampleIntervalMs);
    const sample = await collectMemorySample({
      sampleIndex,
      pageClient,
      swClient,
      offscreenClient
    });
    samples.push(sample);
    logSample(sample);
    sampleIndex += 1;
  }

  const offscreenSummary = summarizeHeapSamples(samples, "offscreen");
  assert(offscreenSummary, "Offscreen heap samples were unavailable.", { samples });

  const swSummary = summarizeHeapSamples(samples, "sw");
  const pageSummary = summarizeHeapSamples(samples, "page");

  assert(
    offscreenSummary.finalGrowthMb <= offscreenFinalGrowthLimitMb,
    "Offscreen heap retained too much memory after the stress window.",
    {
      offscreenSummary,
      limitMb: offscreenFinalGrowthLimitMb
    }
  );

  if (swSummary) {
    assert(swSummary.finalGrowthMb <= swFinalGrowthLimitMb, "Service worker heap grew too much.", {
      swSummary,
      limitMb: swFinalGrowthLimitMb
    });
  }

  const stop = await stopActiveSessionFromPopup(popupClient, active.sid);
  assert(stop?.ok === true, "Failed to stop full mode session.", stop);

  const indicatorGone = await waitForIndicatorGone(pageClient, 15_000);
  assert(indicatorGone === true, "Full mode indicator did not clear after stop.", {
    indicatorGone
  });

  const portTraffic = summarizePortTraffic(await readPortTrafficStats(swClient));
  assert(portTraffic, "Service worker reported no offscreen port traffic.");
  assert(
    findBloatedBinaryTraffic(portTraffic).length === 0,
    "Binary payloads crossed the offscreen port in a bloated form.",
    { portTraffic }
  );

  const sessionsAfterStop = await readRuntimeSessions(popupClient);
  assert(
    Array.isArray(sessionsAfterStop) && sessionsAfterStop.length === 0,
    "Runtime sessions were not cleared after stop.",
    { sessionsAfterStop }
  );

  if (state.offscreenClient) {
    await closeClient(state.offscreenClient);
    state.offscreenClient = null;
  }

  const deleted = await deleteSessionFromPopup(popupClient, active.sid);
  assert(deleted?.ok === true, "Failed to delete stopped session.", deleted);

  await waitForTargetGone(
    baseUrl,
    browserClient,
    (target) =>
      typeof target.url === "string" &&
      target.url === `chrome-extension://${extensionId}/offscreen.html`,
    20_000,
    "Offscreen document target did not close after session deletion"
  );

  assert(swExceptions.length === 0, "Service worker threw runtime exceptions.", {
    swExceptions
  });
  assert(offscreenExceptions.length === 0, "Offscreen document threw runtime exceptions.", {
    offscreenExceptions
  });

  console.log("Stress:", JSON.stringify(lastStressState));
  console.log("Offscreen summary:", JSON.stringify(offscreenSummary));
  console.log("SW summary:", JSON.stringify(swSummary));
  console.log("Page summary:", JSON.stringify(pageSummary));
  console.log("Port traffic (SW<->offscreen):", JSON.stringify(portTraffic));
  console.log(`Chrome log: ${chromeLogPath}`);
  console.log("Full memory regression passed.");

  await cleanup();
}

async function startStressServer() {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

    if (
      requestUrl.pathname === "/" ||
      requestUrl.pathname === "/stress" ||
      requestUrl.pathname === "/stress/"
    ) {
      const html = buildStressPageHtml();
      const bytes = Buffer.from(html);
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-length": bytes.byteLength
      });
      response.end(bytes);
      return;
    }

    if (requestUrl.pathname.startsWith("/api/ping/")) {
      const seq = requestUrl.pathname.slice("/api/ping/".length);
      const token = requestUrl.searchParams.get("token") ?? "missing-token";
      const pad = "x".repeat(Math.max(16, Math.min(stressPayloadBytes, 4096)));
      const payload = {
        ok: true,
        seq,
        token,
        generatedAt: new Date().toISOString(),
        payload: `${pad}:${seq}:${token}`
      };
      const bytes = Buffer.from(JSON.stringify(payload));

      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-length": bytes.byteLength
      });
      response.end(bytes);
      return;
    }

    response.writeHead(404, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(JSON.stringify({ ok: false, error: "not-found", path: requestUrl.pathname }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  assert(address && typeof address !== "string", "Failed to resolve stress server port.");

  return {
    server,
    port: address.port
  };
}

function buildStressPageHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>WebBlackbox Memory Stress</title>
    <style>
      body {
        margin: 0;
        font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        background: #f7f2e8;
        color: #1f2a33;
      }
      main {
        max-width: 960px;
        margin: 0 auto;
        padding: 32px 20px 48px;
      }
      #root {
        display: grid;
        gap: 10px;
        margin-top: 24px;
      }
      .card {
        padding: 12px;
        border: 1px solid #c7b79f;
        background: #fffaf2;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>WebBlackbox Full-Mode Memory Stress</h1>
      <p>This page is controlled by the E2E regression script.</p>
      <div id="root">
        <div class="card">waiting-for-stress-runner</div>
      </div>
    </main>
  </body>
</html>`;
}

async function waitForTargetGone(urlBase, browserClient, matcher, timeoutMs, timeoutMessage) {
  return waitFor(
    async () => {
      const targets = await listTargets(urlBase, browserClient);
      return targets.some(matcher) ? null : true;
    },
    timeoutMs,
    250,
    timeoutMessage
  );
}

async function startSessionFromPopup(popupClient, mode, expectedUrl) {
  const expression = `
    (async () => {
      const tabs = await chrome.tabs.query({});
      const target =
        tabs.find((tab) =>
          typeof tab.id === 'number' &&
          typeof tab.url === 'string' &&
          tab.url.startsWith(${JSON.stringify(expectedUrl)})
        ) ??
        tabs.find((tab) =>
          typeof tab.id === 'number' &&
          typeof tab.url === 'string' &&
          !tab.url.startsWith('chrome-extension://') &&
          tab.url !== 'about:blank'
        );

      if (!target || typeof target.id !== 'number') {
        return {
          ok: false,
          reason: 'target-tab-not-found',
          tabs: tabs.map((tab) => ({ id: tab.id, url: tab.url, active: tab.active }))
        };
      }

      await chrome.runtime.sendMessage({
        kind: 'ui.start',
        tabId: target.id,
        mode: ${JSON.stringify(mode)}
      });

      return {
        ok: true,
        tabId: target.id,
        mode: ${JSON.stringify(mode)}
      };
    })()
  `;

  return popupClient.evaluate(expression);
}

async function stopActiveSessionFromPopup(popupClient, expectedSid) {
  const expression = `
    (async () => {
      const store = await chrome.storage.local.get('webblackbox.runtime.sessions');
      const rows = store['webblackbox.runtime.sessions'];
      const sessions = Array.isArray(rows) ? rows : [];
      const expectedSid = ${JSON.stringify(expectedSid)};
      const active =
        (expectedSid
          ? sessions.find((row) => row?.sid === expectedSid && typeof row?.tabId === 'number')
          : undefined) ??
        sessions.find((row) => typeof row?.tabId === 'number');

      if (!active || typeof active.tabId !== 'number') {
        if (expectedSid) {
          return {
            ok: true,
            sid: expectedSid,
            alreadyStopped: true,
            rows: sessions
          };
        }

        return { ok: false, reason: 'no-active-session', rows: sessions };
      }

      await chrome.runtime.sendMessage({ kind: 'ui.stop', tabId: active.tabId });
      return { ok: true, tabId: active.tabId };
    })()
  `;

  return popupClient.evaluate(expression);
}

async function startStressScenario(pageClient, options) {
  const expression = `
    (() => {
      if (globalThis.__WB_MEM_STRESS__?.running) {
        return { ok: true, alreadyRunning: true, state: globalThis.__WB_MEM_STRESS__ };
      }

      const root =
        document.querySelector('#root') ??
        (() => {
          const next = document.createElement('div');
          next.id = 'root';
          document.body.appendChild(next);
          return next;
        })();

      const state = {
        running: true,
        done: false,
        failed: false,
        count: 0,
        errors: 0,
        requested: ${Math.max(1, Math.floor(options.requests))},
        concurrency: ${Math.max(1, Math.floor(options.concurrency))},
        startedAt: Date.now(),
        lastToken: null,
        error: null
      };

      const apiBaseUrl = ${JSON.stringify(options.apiBaseUrl)};
      const seed = ${JSON.stringify(options.seed)};
      const pauseMs = ${Math.max(0, Math.floor(options.pauseMs))};
      const requestCount = state.requested;
      const concurrency = state.concurrency;
      let cursor = 0;

      const renderCard = (seq, token) => {
        const card = document.createElement('article');
        card.className = 'card';
        card.dataset.seq = String(seq);
        card.textContent = 'row-' + seq + ' token=' + token + ' marker=' + 'x'.repeat(96);
        return card;
      };

      const writeUi = (seq, token) => {
        const cards = [];

        for (let index = 0; index < 4; index += 1) {
          cards.push(renderCard(seq * 4 + index, token));
        }

        root.replaceChildren(...cards);
      };

      globalThis.__WB_MEM_STRESS__ = state;

      const worker = async (workerId) => {
        while (true) {
          const seq = cursor;

          if (seq >= requestCount) {
            return;
          }

          cursor += 1;
          const token = seed + '-' + workerId + '-' + seq;
          writeUi(seq, token);
          console.info('wb-mem-stress', token);

          try {
            const response = await fetch(apiBaseUrl + seq + '?token=' + encodeURIComponent(token), {
              cache: 'no-store',
              headers: {
                'x-webblackbox-stress': token
              }
            });
            const payload = await response.json();
            state.lastToken = payload.token ?? token;
          } catch (error) {
            state.errors += 1;
            state.error = String(error instanceof Error ? error.message : error);
          }

          state.count = Math.max(state.count, seq + 1);

          if (pauseMs > 0) {
            await new Promise((resolve) => {
              setTimeout(resolve, pauseMs);
            });
          }
        }
      };

      Promise.all(Array.from({ length: concurrency }, (_, workerId) => worker(workerId)))
        .then(() => {
          state.running = false;
          state.done = true;
          state.finishedAt = Date.now();
        })
        .catch((error) => {
          state.running = false;
          state.done = true;
          state.failed = true;
          state.error = String(error instanceof Error ? error.message : error);
          state.finishedAt = Date.now();
        });

      return {
        ok: true,
        state
      };
    })()
  `;

  return pageClient.evaluate(expression);
}

async function readStressState(pageClient) {
  return pageClient.evaluate(`
    (() => {
      const state = globalThis.__WB_MEM_STRESS__;

      if (!state) {
        return null;
      }

      return {
        running: state.running === true,
        done: state.done === true,
        failed: state.failed === true,
        count: typeof state.count === 'number' ? state.count : 0,
        errors: typeof state.errors === 'number' ? state.errors : 0,
        requested: typeof state.requested === 'number' ? state.requested : 0,
        concurrency: typeof state.concurrency === 'number' ? state.concurrency : 0,
        startedAt: typeof state.startedAt === 'number' ? state.startedAt : null,
        finishedAt: typeof state.finishedAt === 'number' ? state.finishedAt : null,
        lastToken: typeof state.lastToken === 'string' ? state.lastToken : null,
        error: typeof state.error === 'string' ? state.error : null
      };
    })()
  `);
}

async function prepareHeapSampling(client) {
  await client.send("Runtime.enable").catch(() => undefined);
  await client.send("HeapProfiler.enable").catch(() => undefined);
}

async function collectMemorySample({ sampleIndex, pageClient, swClient, offscreenClient }) {
  const [page, sw, offscreen, stress] = await Promise.all([
    readTargetHeap(pageClient, "page"),
    readTargetHeap(swClient, "sw"),
    readTargetHeap(offscreenClient, "offscreen"),
    readStressState(pageClient).catch(() => null)
  ]);

  return {
    sampleIndex,
    at: new Date().toISOString(),
    page,
    sw,
    offscreen,
    stress
  };
}

async function readTargetHeap(client, label) {
  await client.send("HeapProfiler.collectGarbage").catch(() => undefined);

  const runtimeHeap = await client.send("Runtime.getHeapUsage").catch(() => null);

  if (typeof runtimeHeap?.usedSize === "number") {
    return {
      label,
      source: "Runtime.getHeapUsage",
      usedBytes: runtimeHeap.usedSize,
      totalBytes: typeof runtimeHeap.totalSize === "number" ? runtimeHeap.totalSize : null,
      usedMb: toMb(runtimeHeap.usedSize),
      totalMb: typeof runtimeHeap.totalSize === "number" ? toMb(runtimeHeap.totalSize) : null
    };
  }

  const performanceMemory = await client
    .evaluate(
      `
      (() => {
        if (
          typeof performance !== 'object' ||
          performance === null ||
          typeof performance.memory !== 'object' ||
          performance.memory === null
        ) {
          return null;
        }

        return {
          usedSize: performance.memory.usedJSHeapSize,
          totalSize: performance.memory.totalJSHeapSize
        };
      })()
    `
    )
    .catch(() => null);

  if (typeof performanceMemory?.usedSize === "number") {
    return {
      label,
      source: "performance.memory",
      usedBytes: performanceMemory.usedSize,
      totalBytes:
        typeof performanceMemory.totalSize === "number" ? performanceMemory.totalSize : null,
      usedMb: toMb(performanceMemory.usedSize),
      totalMb:
        typeof performanceMemory.totalSize === "number" ? toMb(performanceMemory.totalSize) : null
    };
  }

  return {
    label,
    source: "unavailable",
    usedBytes: null,
    totalBytes: null,
    usedMb: null,
    totalMb: null
  };
}

function summarizeHeapSamples(samples, key) {
  const usedBytes = samples
    .map((sample) => sample[key]?.usedBytes)
    .filter((value) => typeof value === "number" && Number.isFinite(value));

  if (usedBytes.length === 0) {
    return null;
  }

  const baselineBytes = usedBytes[0];
  const peakBytes = Math.max(...usedBytes);
  const finalBytes = usedBytes[usedBytes.length - 1];

  return {
    target: key,
    samples: usedBytes.length,
    baselineMb: toMb(baselineBytes),
    peakMb: toMb(peakBytes),
    finalMb: toMb(finalBytes),
    peakGrowthMb: toMb(peakBytes - baselineBytes),
    finalGrowthMb: toMb(finalBytes - baselineBytes)
  };
}

function logSample(sample) {
  const progress = sample.stress?.count ?? 0;
  const requested = sample.stress?.requested ?? 0;
  console.log(
    [
      `[sample ${sample.sampleIndex}]`,
      `progress=${progress}/${requested}`,
      `page=${formatTargetMb(sample.page)}`,
      `sw=${formatTargetMb(sample.sw)}`,
      `offscreen=${formatTargetMb(sample.offscreen)}`
    ].join(" ")
  );
}

function formatTargetMb(target) {
  if (!target || typeof target.usedMb !== "number") {
    return "n/a";
  }

  return `${target.usedMb.toFixed(2)}MB`;
}

function toMb(bytes) {
  return Number((bytes / (1024 * 1024)).toFixed(2));
}

async function cleanup() {
  await closeClient(state.offscreenClient);
  state.offscreenClient = null;

  await closeClient(state.swClient);
  state.swClient = null;

  await closeClient(state.pageClient);
  state.pageClient = null;

  await closeClient(state.popupClient);
  state.popupClient = null;

  await closeClient(state.browserClient);
  state.browserClient = null;

  for (const targetId of state.openedTargetIds.splice(0)) {
    await closeTarget(baseUrl, targetId);
  }

  if (state.chromeProcess && !state.chromeProcess.killed) {
    state.chromeProcess.kill("SIGTERM");
    await sleep(700);

    if (!state.chromeProcess.killed) {
      state.chromeProcess.kill("SIGKILL");
    }
  }

  state.chromeProcess = null;

  if (state.logStream) {
    await new Promise((resolve) => {
      state.logStream.end(resolve);
    });
    state.logStream = null;
  }

  if (state.server) {
    await new Promise((resolve) => {
      state.server.close(() => resolve());
    });
    state.server = null;
  }
}
