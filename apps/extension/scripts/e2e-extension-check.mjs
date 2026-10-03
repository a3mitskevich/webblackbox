#!/usr/bin/env node

import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CdpClient } from "./lib/cdp-client.mjs";
import {
  CHROME_LAUNCH_PROFILES,
  ensureExtensionBuildReady,
  resolveChromeBinary,
  startChrome,
  waitForChromeReady
} from "./lib/chrome-launcher.mjs";
import { closeTarget, extractExtensionId, openTarget } from "./lib/devtools-targets.mjs";
import { assert, fetchJson, sleep, waitFor } from "./lib/e2e-utils.mjs";
import {
  readRuntimeSessions,
  waitForIndicatorGone,
  waitForIndicatorText
} from "./lib/extension-ui.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(root, "..");

const extensionDir = process.env.WB_E2E_EXTENSION_DIR ?? resolve(appRoot, "build");
const targetUrl = process.env.WB_E2E_TARGET_URL ?? "https://example.com/";
const remotePort = Number(process.env.WB_E2E_REMOTE_PORT ?? "9222");
const headless = (process.env.WB_E2E_HEADLESS ?? "1") !== "0";
const profileDir =
  process.env.WB_E2E_PROFILE_DIR ?? `/tmp/webblackbox-ext-e2e-profile-${Date.now()}`;
const chromeLogPath = process.env.WB_E2E_LOG ?? `/tmp/webblackbox-ext-e2e-${Date.now()}.log`;
const baseUrl = `http://127.0.0.1:${remotePort}`;
const checkExport = (process.env.WB_E2E_CHECK_EXPORT ?? "1") !== "0";

const state = {
  chromeProcess: null,
  logStream: null,
  swClient: null,
  popupClient: null,
  pageClient: null,
  openedTargetIds: []
};

main().catch(async (error) => {
  console.error("E2E check failed:", error instanceof Error ? error.message : String(error));
  await cleanup();
  process.exit(1);
});

async function main() {
  await ensureExtensionBuildReady(extensionDir);
  const chromeBinary = await resolveChromeBinary();

  await rm(profileDir, { recursive: true, force: true });
  await mkdir(profileDir, { recursive: true });

  const { proc, logStream } = startChrome(chromeBinary, {
    extensionDir,
    profileDir,
    remotePort,
    headless,
    logPath: chromeLogPath,
    ...CHROME_LAUNCH_PROFILES.extensionCheck
  });

  state.chromeProcess = proc;
  state.logStream = logStream;

  const version = await waitForChromeReady(baseUrl, 20_000);
  console.log(`Chrome: ${version.Browser}`);

  const swTarget = await waitForExtensionServiceWorker(baseUrl, 20_000);
  const extensionId = extractExtensionId(swTarget.url);
  console.log(`Extension ID: ${extensionId}`);

  const swClient = new CdpClient(swTarget.webSocketDebuggerUrl);
  await swClient.connect();
  await swClient.send("Runtime.enable");
  state.swClient = swClient;

  const swExceptions = [];
  swClient.on("Runtime.exceptionThrown", (params) => {
    swExceptions.push({
      text: params?.exceptionDetails?.text ?? "unknown",
      line: params?.exceptionDetails?.lineNumber ?? null
    });
  });

  const pageTarget = await openTarget(baseUrl, targetUrl);
  const popupTarget = await openTarget(baseUrl, `chrome-extension://${extensionId}/popup.html`);
  state.openedTargetIds.push(pageTarget.id, popupTarget.id);

  const pageClient = new CdpClient(pageTarget.webSocketDebuggerUrl);
  const popupClient = new CdpClient(popupTarget.webSocketDebuggerUrl);
  await pageClient.connect();
  await popupClient.connect();
  await pageClient.send("Runtime.enable");
  await popupClient.send("Runtime.enable");
  state.pageClient = pageClient;
  state.popupClient = popupClient;

  await sleep(1_200);

  const lite = await runModeCheck({
    popupClient,
    pageClient,
    mode: "lite",
    targetUrl,
    waitStartMs: 20_000,
    waitStopMs: 10_000,
    exportAfterStop: checkExport
  });

  const full = await runModeCheck({
    popupClient,
    pageClient,
    mode: "full",
    targetUrl,
    waitStartMs: 25_000,
    waitStopMs: 12_000,
    exportAfterStop: false
  });

  const finalStorage = await readRuntimeSessions(popupClient);
  assert(
    Array.isArray(finalStorage) && finalStorage.length === 0,
    "Final sessions should be empty",
    {
      finalStorage
    }
  );

  if (swExceptions.length > 0) {
    throw new Error(`Service worker threw runtime exceptions: ${JSON.stringify(swExceptions)}`);
  }

  console.log("Lite:", JSON.stringify(lite));
  console.log("Full:", JSON.stringify(full));
  console.log("Final storage:", JSON.stringify(finalStorage));
  console.log("Service worker exceptions:", JSON.stringify(swExceptions));
  console.log(`Chrome log: ${chromeLogPath}`);
  console.log("E2E check passed.");

  await cleanup();
}

async function runModeCheck({
  popupClient,
  pageClient,
  mode,
  targetUrl,
  waitStartMs,
  waitStopMs,
  exportAfterStop
}) {
  const start = await startSessionFromPopup(popupClient, mode, targetUrl);
  assert(start?.ok === true, `Failed to start ${mode} mode`, start);

  const indicatorText = await waitForIndicatorText(pageClient, `REC ${mode}`, waitStartMs);
  assert(typeof indicatorText === "string", `${mode} indicator not found`, {
    indicatorText,
    start
  });

  const sessionsAfterStart = await readRuntimeSessions(popupClient);
  assert(
    Array.isArray(sessionsAfterStart) && sessionsAfterStart.length === 1,
    `${mode} did not persist exactly one session`,
    {
      sessionsAfterStart
    }
  );

  const active = sessionsAfterStart[0];
  assert(active?.mode === mode, `${mode} session mode mismatch`, {
    expected: mode,
    actual: active?.mode,
    sessionsAfterStart
  });

  const stop = await stopActiveSessionFromPopup(popupClient);
  assert(stop?.ok === true, `Failed to stop ${mode} mode`, stop);

  const gone = await waitForIndicatorGone(pageClient, waitStopMs);
  assert(gone, `${mode} indicator did not clear`, { gone, stop });

  const sessionsAfterStop = await readRuntimeSessions(popupClient);
  assert(
    Array.isArray(sessionsAfterStop) && sessionsAfterStop.length === 0,
    `${mode} sessions were not cleared`,
    {
      sessionsAfterStop
    }
  );

  let exportStatus = undefined;

  if (exportAfterStop) {
    const statusBefore = await readExportStatusLine(popupClient);
    await exportSessionFromPopup(popupClient, active.sid);
    exportStatus = await waitForExportStatus(popupClient, statusBefore, 30_000);
    assert(exportStatus.ok, `${mode} export failed`, exportStatus);
  }

  return {
    start,
    indicatorText,
    stop,
    exportStatus
  };
}

async function waitForExtensionServiceWorker(urlBase, timeoutMs) {
  return waitFor(
    async () => {
      const targets = await fetchJson(`${urlBase}/json/list`, 4_000);
      if (!Array.isArray(targets)) {
        return null;
      }

      return (
        targets.find(
          (target) =>
            target?.type === "service_worker" &&
            typeof target?.url === "string" &&
            target.url.startsWith("chrome-extension://") &&
            target.url.endsWith("/sw.js")
        ) ?? null
      );
    },
    timeoutMs,
    250,
    "Extension service worker target not found"
  );
}

async function startSessionFromPopup(popupClient, mode, expectedUrl) {
  const expression = `
    (async () => {
      const tabs = await chrome.tabs.query({});
      const exact = tabs.find((tab) =>
        typeof tab.id === 'number' && typeof tab.url === 'string' && tab.url.startsWith(${JSON.stringify(
          expectedUrl
        )})
      );

      const fallback = tabs.find((tab) =>
        typeof tab.id === 'number' &&
        typeof tab.url === 'string' &&
        !tab.url.startsWith('chrome-extension://') &&
        tab.url !== 'about:blank'
      );

      const target = exact ?? fallback;

      if (!target || typeof target.id !== 'number') {
        return {
          ok: false,
          reason: 'target-tab-not-found',
          tabs: tabs.map((tab) => ({ id: tab.id, url: tab.url, active: tab.active }))
        };
      }

      await chrome.runtime.sendMessage({ kind: 'ui.start', tabId: target.id, mode: ${JSON.stringify(
        mode
      )} });
      return { ok: true, tabId: target.id, mode: ${JSON.stringify(mode)} };
    })()
  `;

  return popupClient.evaluate(expression);
}

async function stopActiveSessionFromPopup(popupClient) {
  const expression = `
    (async () => {
      const store = await chrome.storage.local.get('webblackbox.runtime.sessions');
      const rows = store['webblackbox.runtime.sessions'];
      const active = Array.isArray(rows) ? rows[0] : undefined;

      if (!active || typeof active.tabId !== 'number') {
        return { ok: false, reason: 'no-active-session', rows };
      }

      await chrome.runtime.sendMessage({ kind: 'ui.stop', tabId: active.tabId });
      return { ok: true, tabId: active.tabId };
    })()
  `;

  return popupClient.evaluate(expression);
}

async function exportSessionFromPopup(popupClient, sid) {
  const expression = `
    (async () => {
      await chrome.runtime.sendMessage({ kind: 'ui.export', sid: ${JSON.stringify(sid)} });
      return { ok: true, sid: ${JSON.stringify(sid)} };
    })()
  `;

  return popupClient.evaluate(expression);
}

async function readExportStatusLine(popupClient) {
  const expression = `
    (() => {
      const lines = Array.from(document.querySelectorAll('p')).map((el) =>
        (el.textContent ?? '').trim()
      );
      return lines.find((line) => line.startsWith('Export')) ?? null;
    })()
  `;

  return popupClient.evaluate(expression);
}

async function waitForExportStatus(popupClient, previousStatus, timeoutMs) {
  return waitFor(
    async () => {
      const status = await readExportStatusLine(popupClient);

      if (!status || status === previousStatus) {
        return null;
      }

      return {
        ok: status.startsWith("Exported:"),
        text: status
      };
    },
    timeoutMs,
    250,
    "Export status not observed"
  );
}

async function cleanup() {
  if (state.pageClient) {
    state.pageClient.close();
    state.pageClient = null;
  }

  if (state.popupClient) {
    state.popupClient.close();
    state.popupClient = null;
  }

  if (state.swClient) {
    state.swClient.close();
    state.swClient = null;
  }

  for (const targetId of state.openedTargetIds.splice(0)) {
    await closeTarget(baseUrl, targetId);
  }

  if (state.chromeProcess && !state.chromeProcess.killed) {
    state.chromeProcess.kill("SIGTERM");
    await sleep(500);

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
}
