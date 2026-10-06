#!/usr/bin/env node

import { createServer } from "node:http";
import { constants } from "node:fs";
import { access, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  checkArchiveBasics,
  checkArchiveEvidence,
  checkCompleteness,
  checkResponseBodyPreview,
  checkScreenRecording,
  checkScreenshots,
  openArchive
} from "./lib/archive-checks.mjs";
import { CdpClient } from "./lib/cdp-client.mjs";
import {
  CHROME_LAUNCH_PROFILES,
  launchChromeWithRetry,
  resolveChromeBinary,
  terminateChromeProcess
} from "./lib/chrome-launcher.mjs";
import {
  closeTarget,
  extractExtensionId,
  isLikelyExtensionId,
  listHttpTargets as listTargets,
  openTarget,
  resolvePreferredExtensionId,
  summarizeTargetsForDebug
} from "./lib/devtools-targets.mjs";
import {
  assert,
  fetchJson,
  printChromeConsoleTail,
  readPositiveInteger,
  sleep,
  waitFor
} from "./lib/e2e-utils.mjs";
import { waitForIndicatorGone, waitForIndicatorText } from "./lib/extension-ui.mjs";
import { PLAYER_READY_SELECTOR, runPlayerSmoke } from "./lib/player-smoke.mjs";
import {
  enablePortTrafficMeter,
  readPortTrafficStats,
  summarizePortTraffic
} from "./lib/port-traffic.mjs";
import { REALISTIC_DEFAULT_DURATION_MS, startRealisticSite } from "./lib/realistic-site.mjs";
import {
  attachFidelitySocketServer,
  runCaptureFidelityScenario,
  serveFidelityImage,
  verifyCaptureFidelityArchive
} from "./lib/e2e-capture-fidelity.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(root, "..");
const workspaceRoot = resolve(extensionRoot, "..", "..");

const extensionDir = process.env.WB_E2E_EXTENSION_DIR ?? resolve(extensionRoot, "build");
const demoDir = resolve(extensionRoot, "e2e-demo");
const playerDir = process.env.WB_E2E_PLAYER_DIR ?? resolve(workspaceRoot, "apps/player/build");

const remotePort = Number(process.env.WB_E2E_REMOTE_PORT ?? "9233");
const headless = (process.env.WB_E2E_HEADLESS ?? "1") !== "0";
const profileDir =
  process.env.WB_E2E_PROFILE_DIR ?? `/tmp/webblackbox-ext-fullchain-profile-${Date.now()}`;
const downloadDir =
  process.env.WB_E2E_DOWNLOAD_DIR ?? `/tmp/webblackbox-ext-fullchain-downloads-${Date.now()}`;
const chromeLogPath = process.env.WB_E2E_LOG ?? `/tmp/webblackbox-ext-fullchain-${Date.now()}.log`;
const chromeReadyTimeoutMs = Number(process.env.WB_E2E_CHROME_READY_TIMEOUT_MS ?? "25000");
const chromeLaunchAttempts = Number(process.env.WB_E2E_CHROME_LAUNCH_ATTEMPTS ?? "2");
const downloadTimeoutMs = Number(process.env.WB_E2E_DOWNLOAD_TIMEOUT_MS ?? "45000");
const downloadApiTimeoutMs = readPositiveInteger(
  process.env.WB_E2E_DOWNLOAD_API_TIMEOUT_MS,
  12_000
);
const cdpCommandTimeoutMs = readPositiveInteger(process.env.WB_E2E_CDP_COMMAND_TIMEOUT_MS, 15_000);
const cdpClientOptions = { commandTimeoutMs: cdpCommandTimeoutMs };
const FAILURE_CONSOLE_TAIL_LINES = 60;
const captureMode = process.env.WB_E2E_MODE === "lite" ? "lite" : "full";
const reloadAfterStart = (process.env.WB_E2E_RELOAD_AFTER_START ?? "0") === "1";
// "on-start": the content script is injected on Start only, so the run controls the extension
// from the popup page (there is no content-script runtime in the page before Start).
const injectionMode = process.env.WB_E2E_INJECTION_MODE === "on-start" ? "on-start" : "always";
const fullVisualCapture = normalizeFullVisualCaptureMode(
  process.env.WB_E2E_FULL_VISUAL_CAPTURE ??
    ((process.env.WB_E2E_RECORD_SCREEN ?? "0") === "1" ? "recording" : "screenshots")
);
const recordScreenInFullMode =
  captureMode === "full" && (fullVisualCapture === "recording" || fullVisualCapture === "both");
const captureScreenshotsInFullMode =
  captureMode === "full" && (fullVisualCapture === "screenshots" || fullVisualCapture === "both");
const configureRecorderOptions = (process.env.WB_E2E_CONFIGURE_OPTIONS ?? "1") !== "0";
// Needs the configured console: allow / network: body-allowlist policy and CDP capture.
// `e2e:completeness:full`: records the realistic fixture site (lib/realistic-site.mjs) with the
// Full capture sampling and checks that the archive holds every body the policy asked for, or says
// why one is missing; the demo page scenarios are skipped.
const completenessMode = captureMode === "full" && (process.env.WB_E2E_COMPLETENESS ?? "0") === "1";
// Full mode records script → source map references unless a profile turns them off. The
// completeness run records the realistic fixture site, which has no minified demo bundle.
const verifySourceMaps =
  captureMode === "full" &&
  !completenessMode &&
  (process.env.WB_E2E_VERIFY_SOURCE_MAPS ?? "1") !== "0";
const completenessDurationMs = readPositiveInteger(
  process.env.WB_E2E_COMPLETENESS_MS,
  REALISTIC_DEFAULT_DURATION_MS
);
// The configured full-mode policy asks for bodies (`body-allowlist`).
const bodiesRequested = captureMode === "full" && configureRecorderOptions;
const checkCaptureFidelity = bodiesRequested && !completenessMode;
// Lite records console text and stacks through the page hook under the same console: allow policy.
const checkConsoleFidelity = captureMode === "lite" && configureRecorderOptions;
const checkAnyFidelity = checkCaptureFidelity || checkConsoleFidelity;
const playerSdkEntry = resolve(workspaceRoot, "packages/player-sdk/dist/index.js");
const usePopupUiActions =
  process.env.WB_E2E_USE_POPUP_UI === undefined
    ? !headless
    : process.env.WB_E2E_USE_POPUP_UI !== "0";
const exportPassphrase = process.env.WB_E2E_EXPORT_PASSPHRASE ?? "webblackbox-e2e-passphrase";
const e2eExportPolicy = {
  includeScreenshots: captureScreenshotsInFullMode,
  includeScreenRecordings: recordScreenInFullMode,
  maxArchiveBytes: 100 * 1024 * 1024,
  recentWindowMs: 20 * 60 * 1000
};
const realWorldScenario = process.env.WB_E2E_REALWORLD_SCENARIO ?? "";
const realWorldLongRecordingMs = Number(process.env.WB_E2E_REALWORLD_LONG_MS ?? "2500");
const realWorldLargeResponseBytes = Number(
  process.env.WB_E2E_REALWORLD_LARGE_RESPONSE_BYTES ?? "1048576"
);

function normalizeFullVisualCaptureMode(value) {
  return value === "recording" || value === "both" || value === "none" ? value : "screenshots";
}

const state = {
  chromeProcess: null,
  logStream: null,
  browserClient: null,
  swClient: null,
  popupClient: null,
  demoClient: null,
  playerClient: null,
  openedTargetIds: [],
  tempExtensionDir: null,
  server: null,
  fidelitySockets: null,
  realisticSite: null,
  baseUrl: null
};

main().catch(async (error) => {
  console.error("Fullchain E2E failed:", error instanceof Error ? error.message : String(error));

  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }

  await printChromeConsoleTail(chromeLogPath, FAILURE_CONSOLE_TAIL_LINES);
  await cleanup();
  process.exit(1);
});

async function main() {
  await ensureBuildInputs();

  await mkdir(downloadDir, { recursive: true });
  const extensionDirForRun = recordScreenInFullMode
    ? await prepareScreenRecordingE2eExtensionDir(extensionDir)
    : extensionDir;
  state.tempExtensionDir = extensionDirForRun === extensionDir ? null : extensionDirForRun;

  const server = await startDemoServer({
    demoDir,
    playerDir,
    artifactsDir: downloadDir
  });

  state.server = server.server;
  state.fidelitySockets = server.fidelitySockets;

  state.realisticSite = completenessMode ? await startRealisticSite({ holdRequests: true }) : null;
  const demoUrl = state.realisticSite?.pageUrl ?? `http://127.0.0.1:${server.port}/demo/`;
  const playerUrl = `http://127.0.0.1:${server.port}/player/`;

  const chromeBinary = await resolveChromeBinary();
  const preferredExtensionId = await resolvePreferredExtensionId(extensionDirForRun);

  const chrome = await launchChromeWithRetry(chromeBinary, {
    extensionDir: extensionDirForRun,
    // The previous inline launcher accepted allowlistedExtensionId but never put it on the
    // command line; it stays off here to keep the run identical. Add it to the chrome extraArgs
    // (--allowlisted-extension-id=<id>) if screen recording e2e ever needs it.
    profileDir,
    remotePort,
    headless,
    logPath: chromeLogPath,
    chrome: CHROME_LAUNCH_PROFILES.fullchain,
    attempts: Math.max(1, Math.floor(chromeLaunchAttempts)),
    readyTimeoutMs: Math.max(10_000, Math.floor(chromeReadyTimeoutMs))
  });
  const baseUrl = chrome.baseUrl;

  state.chromeProcess = chrome.proc;
  state.logStream = chrome.logStream;
  state.baseUrl = baseUrl;

  const version = chrome.version;
  console.log(`Chrome: ${version.Browser}`);
  assertCommandLineExtensionLoadingSupported(chromeBinary, version.Browser);

  const browserWsUrl =
    typeof version.webSocketDebuggerUrl === "string" ? version.webSocketDebuggerUrl : null;

  if (browserWsUrl) {
    const browserClient = new CdpClient(browserWsUrl, cdpClientOptions);
    await browserClient.connect();
    state.browserClient = browserClient;
    await browserClient
      .send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: downloadDir,
        eventsEnabled: true
      })
      .catch(() => undefined);
  }

  // Open demo early so content scripts can wake the extension worker in CI/headless runs.
  const demoTarget = await openTarget(baseUrl, demoUrl);
  state.openedTargetIds.push(demoTarget.id);

  if (preferredExtensionId) {
    console.log(`Preferred extension ID: ${preferredExtensionId}`);
  }

  let swTarget = await waitForExtensionServiceWorker(baseUrl, 8_000, preferredExtensionId).catch(
    () => null
  );
  if (!swTarget) {
    swTarget = await waitForExtensionServiceWorker(baseUrl, 20_000, preferredExtensionId).catch(
      () => null
    );
  }
  const extensionId = swTarget
    ? extractExtensionId(swTarget.url)
    : (preferredExtensionId ??
      (await waitForExtensionIdFromProfile(baseUrl, profileDir, extensionDirForRun, 30_000)));
  console.log(`Extension ID: ${extensionId}`);

  let popupTarget = null;
  let warmupPopupTargetId = null;
  const swExceptions = [];

  if (!swTarget && usePopupUiActions) {
    popupTarget = await openTarget(baseUrl, `chrome-extension://${extensionId}/popup.html`);
    state.openedTargetIds.push(popupTarget.id);
    warmupPopupTargetId = popupTarget.id;
    swTarget = await waitForExtensionServiceWorker(baseUrl, 25_000, extensionId).catch(() => null);
  }

  if (swTarget?.webSocketDebuggerUrl) {
    const swClient = new CdpClient(swTarget.webSocketDebuggerUrl, cdpClientOptions);
    await swClient.connect();
    await swClient.send("Runtime.enable");
    state.swClient = swClient;

    swClient.on("Runtime.exceptionThrown", (params) => {
      swExceptions.push({
        text: params?.exceptionDetails?.text ?? "unknown",
        line: params?.exceptionDetails?.lineNumber ?? null
      });
    });
  } else {
    console.warn("Service worker target is unavailable; continuing without SW runtime hook.");
  }

  const demoClient = new CdpClient(demoTarget.webSocketDebuggerUrl, cdpClientOptions);
  const demoContexts = createRuntimeContextTracker(demoClient);
  await demoClient.connect();
  await demoClient.send("Runtime.enable");
  await demoClient.send("DOM.enable");
  state.demoClient = demoClient;

  const usePopupControl =
    recordScreenInFullMode || usePopupUiActions || injectionMode === "on-start";
  let usePopupUiActionsEffective = recordScreenInFullMode ? false : usePopupUiActions;
  let control = null;

  if (usePopupControl) {
    if (!popupTarget) {
      popupTarget = recordScreenInFullMode
        ? await openActionPopupFromShortcut(baseUrl, demoClient, extensionId)
        : await openTarget(baseUrl, `chrome-extension://${extensionId}/popup.html`);
      state.openedTargetIds.push(popupTarget.id);
    } else if (warmupPopupTargetId) {
      await closeTarget(baseUrl, warmupPopupTargetId);
      state.openedTargetIds = state.openedTargetIds.filter((id) => id !== warmupPopupTargetId);
      popupTarget = recordScreenInFullMode
        ? await openActionPopupFromShortcut(baseUrl, demoClient, extensionId)
        : await openTarget(baseUrl, `chrome-extension://${extensionId}/popup.html`);
      state.openedTargetIds.push(popupTarget.id);
    }

    const popupClient = new CdpClient(popupTarget.webSocketDebuggerUrl, cdpClientOptions);
    await popupClient.connect();
    await popupClient.send("Runtime.enable");
    await popupClient.send("DOM.enable");
    state.popupClient = popupClient;

    if (usePopupUiActionsEffective) {
      const popupUiReady = await waitForPopupUiReady(popupClient, 20_000).catch(() => null);

      if (!popupUiReady) {
        const popupRuntimeReady = await waitForPopupRuntimeReady(popupClient, 12_000).catch(
          () => null
        );

        if (popupRuntimeReady) {
          usePopupUiActionsEffective = false;
          console.warn("Popup UI not ready; falling back to runtime message actions.");
        } else {
          throw new Error("Popup UI/runtime is not ready");
        }
      }
    } else {
      const popupRuntimeReady = await waitForPopupRuntimeReady(popupClient, 12_000).catch(
        () => null
      );

      if (!popupRuntimeReady) {
        throw new Error("Popup runtime is not ready");
      }
    }

    control = {
      kind: "popup",
      client: popupClient,
      useUiActions: usePopupUiActionsEffective
    };
  } else {
    let runtimeContext = await waitForExtensionRuntimeContext(
      demoClient,
      demoContexts,
      extensionId,
      15_000
    ).catch(() => null);

    if (!runtimeContext) {
      await demoClient.send("Page.reload", { ignoreCache: true }).catch(() => undefined);
      runtimeContext = await waitForExtensionRuntimeContext(
        demoClient,
        demoContexts,
        extensionId,
        20_000
      );
    }

    control = {
      kind: "content-runtime",
      client: demoClient,
      contextId: runtimeContext.contextId,
      contextTracker: demoContexts,
      extensionId
    };

    if (!state.swClient) {
      swTarget = await waitForExtensionServiceWorker(baseUrl, 10_000, extensionId).catch(
        () => null
      );

      if (swTarget?.webSocketDebuggerUrl) {
        const swClient = new CdpClient(swTarget.webSocketDebuggerUrl, cdpClientOptions);
        await swClient.connect();
        await swClient.send("Runtime.enable");
        state.swClient = swClient;

        swClient.on("Runtime.exceptionThrown", (params) => {
          swExceptions.push({
            text: params?.exceptionDetails?.text ?? "unknown",
            line: params?.exceptionDetails?.lineNumber ?? null
          });
        });
      }
    }
  }

  const demoExceptions = [];
  demoClient.on("Runtime.exceptionThrown", (params) => {
    demoExceptions.push({
      text: params?.exceptionDetails?.text ?? "unknown",
      line: params?.exceptionDetails?.lineNumber ?? null
    });
  });

  const injectionSetup =
    injectionMode === "on-start"
      ? await switchToOnDemandInjection(control, demoClient, demoContexts, extensionId)
      : { ok: true, mode: injectionMode };
  assert(injectionSetup.ok === true, "On-demand injection setup failed", injectionSetup);

  const recorderConfigured = configureRecorderOptions
    ? await configureE2eRecorderOptions(control, captureMode)
    : { ok: true, skipped: "default-recorder-options" };
  assert(recorderConfigured?.ok === true, "Failed to configure E2E recorder options", {
    recorderConfigured,
    captureMode
  });

  await sleep(1_200);

  if (state.swClient) {
    await enablePortTrafficMeter(state.swClient);
  }

  const start = await startSessionFromControl(control, captureMode, demoUrl, {
    visualCapture: fullVisualCapture
  });
  assert(start?.ok === true, `Failed to start ${captureMode} mode`, start);
  const demoTab =
    control.kind === "popup" && control.useUiActions
      ? await findTabByUrlFromPopup(control.client, demoUrl)
      : null;
  if (control.kind === "popup" && control.useUiActions) {
    assert(typeof demoTab?.id === "number", "Demo tab is not discoverable from popup", {
      demoUrl,
      demoTab,
      start
    });
  }

  const indicator = await waitForIndicatorText(demoClient, `REC ${captureMode}`, 25_000);
  assert(typeof indicator === "string", "Recorder indicator did not appear", {
    indicator,
    start
  });

  if (reloadAfterStart) {
    await demoClient.send("Page.reload", { ignoreCache: true });
    const reloadedIndicator = await waitForIndicatorText(demoClient, `REC ${captureMode}`, 25_000);
    assert(
      typeof reloadedIndicator === "string",
      "Recorder indicator did not recover after reload",
      {
        reloadedIndicator,
        captureMode
      }
    );
  }

  if (injectionMode === "on-start") {
    const recordedFrames = await listContentScriptContexts(demoClient, demoContexts, extensionId);
    assert(recordedFrames.length > 0, "Content script missing in the recorded tab", {
      recordedFrames,
      reloadAfterStart
    });
  }

  // The realistic page's held requests started before the capture (or, after a reload, inside it).
  state.realisticSite?.releaseHeld();

  const activeSessions = await readRuntimeSessions(control);
  assert(
    Array.isArray(activeSessions) && activeSessions.length === 1,
    "Expected exactly one active runtime session",
    { activeSessions }
  );

  const sid = activeSessions[0]?.sid;
  assert(typeof sid === "string" && sid.length > 0, "Missing session id", { activeSessions });
  if (typeof demoTab?.id === "number") {
    assert(activeSessions[0]?.tabId === demoTab.id, "Session started on unexpected tab", {
      expectedTabId: demoTab.id,
      activeSessions,
      demoTab,
      start
    });
  }

  if (recordScreenInFullMode) {
    await demoClient.send("Page.bringToFront").catch(() => undefined);
    await demoClient
      .evaluate(
        `
          (() => {
            window.focus();
            return true;
          })()
        `
      )
      .catch(() => undefined);
    await sleep(500);
  }

  const scenarioResult = completenessMode
    ? await runRealisticScenario(demoClient, completenessDurationMs)
    : await runDemoScenario(demoClient);
  assert(scenarioResult?.ok === true, "Demo scenario failed", scenarioResult);
  assert(
    !completenessMode ||
      (scenarioResult.heldRequests > 0 &&
        scenarioResult.heldCompleted === scenarioResult.heldRequests),
    "Realistic page's held requests did not complete",
    scenarioResult
  );

  const minifiedErrorResult = verifySourceMaps ? await logMinifiedBundleError(demoClient) : null;
  assert(
    !verifySourceMaps || minifiedErrorResult?.ok === true,
    "Minified demo bundle did not throw",
    minifiedErrorResult
  );

  const fidelityScenario = checkAnyFidelity
    ? await runCaptureFidelityScenario(demoClient, { consoleOnly: checkConsoleFidelity })
    : { ok: true, skipped: "needs-configured-options" };
  assert(fidelityScenario?.ok === true, "Capture fidelity scenario failed", fidelityScenario);

  const realWorldResult = completenessMode
    ? { ok: true, skipped: "completeness-mode" }
    : await runRealWorldScenarioAddons({
        scenario: realWorldScenario,
        demoClient,
        control,
        baseUrl,
        demoUrl,
        browserClient: state.browserClient,
        extensionId
      });
  assert(realWorldResult.ok, "Real-world scenario failed", realWorldResult);

  const finalMarker = await requestFinalE2eMarkerCapture(demoClient, captureMode);
  assert(finalMarker?.ok === true, "Failed to request final E2E marker capture", finalMarker);

  await sleep(captureMode === "lite" || recordScreenInFullMode ? 2_400 : 1_600);

  const stop = await stopActiveSessionFromControl(control, sid);
  assert(stop?.ok === true, `Failed to stop ${captureMode} mode`, stop);

  const indicatorGone = await waitForIndicatorGone(demoClient, 15_000);
  assert(indicatorGone, "Recorder indicator did not clear after stop", { indicatorGone, stop });

  const sessionsAfterStop = await waitFor(
    async () => {
      const rows = await readRuntimeSessions(control);
      return Array.isArray(rows) && rows.length === 0 ? rows : null;
    },
    10_000,
    200,
    "Runtime sessions were not cleared"
  );
  assert(
    Array.isArray(sessionsAfterStop) && sessionsAfterStop.length === 0,
    "Runtime sessions were not cleared",
    {
      sessionsAfterStop
    }
  );

  const exportStartedAtMs = Date.now();
  const exportStatusBefore =
    control.kind === "popup" && control.useUiActions
      ? await readExportStatusLine(control.client)
      : null;
  const exportTriggered = await exportSessionFromControl(control, sid);
  assert(exportTriggered?.ok === true, "Failed to trigger export from popup", exportTriggered);
  const exportStatus =
    control.kind === "popup" && control.useUiActions
      ? await waitForExportStatus(control.client, exportStatusBefore, 35_000)
      : { ok: true, text: "Export triggered (runtime fallback)." };
  assert(exportStatus?.ok, "Export status indicates failure", exportStatus);

  const downloadClient = control.kind === "popup" ? control.client : state.swClient;
  const downloadRecord = await waitForExportedDownloadWithFallback(
    downloadClient,
    sid,
    exportStartedAtMs,
    downloadTimeoutMs
  );
  assert(typeof downloadRecord?.filename === "string", "Download record missing filename", {
    downloadRecord
  });

  let exportedPath = downloadRecord.filename;
  let fileInfo = await waitForFile(exportedPath, 10_000);

  if (fileInfo.size === 0) {
    const rebuiltPath = resolve(downloadDir, `${sid}.webblackbox`);
    const rebuilt = await rebuildArchiveFromDataUrl(downloadRecord.url, rebuiltPath);

    if (rebuilt) {
      exportedPath = rebuiltPath;
      fileInfo = await waitForFile(exportedPath, 5_000);
    }
  }

  assert(fileInfo.size > 0, "Exported archive is empty", {
    exportedPath,
    fileInfo,
    downloadRecord
  });

  // Archive data is checked on the decrypted archive with the built player-sdk; the Player UI
  // only gets a thin smoke below (see lib/archive-checks.mjs and lib/player-smoke.mjs).
  const archive = await openArchive({
    archivePath: exportedPath,
    passphrase: exportPassphrase,
    playerSdkEntry
  });
  const requiredEventTypes = completenessMode
    ? ["console.entry", "network.body", "network.ws.frame", "perf.vitals", "screen.screenshot"]
    : captureMode === "lite"
      ? [
          "user.mousemove",
          "console.entry",
          "network.request",
          "dom.snapshot",
          "storage.local.snapshot"
        ]
      : !captureScreenshotsInFullMode
        ? ["user.click", "console.entry"]
        : configureRecorderOptions
          ? ["user.click", "screen.screenshot", "console.entry"]
          : ["user.click", "screen.screenshot", "network.request"];
  const archiveBasics = checkArchiveBasics(archive, {
    requiredEventTypes,
    urlIncludes: completenessMode ? "/api/items/" : "/api/"
  });
  assert(
    archiveBasics.ok,
    "Exported archive is missing events, demo API requests or event types",
    archiveBasics
  );

  const archiveEvidenceResult =
    realWorldScenario && realWorldResult.archiveEvidence
      ? checkArchiveEvidence(archive, realWorldResult.archiveEvidence)
      : { ok: true, skipped: true };
  assert(
    archiveEvidenceResult.ok,
    "Exported archive missing real-world captured evidence",
    archiveEvidenceResult
  );

  const fidelityArchiveResult = checkAnyFidelity
    ? await verifyCaptureFidelityArchive({
        archivePath: exportedPath,
        passphrase: exportPassphrase,
        playerSdkEntry,
        scenario: fidelityScenario,
        consoleOnly: checkConsoleFidelity
      })
    : fidelityScenario;
  assert(
    fidelityArchiveResult.ok,
    "Exported archive lost console text, WebSocket payloads or cache status",
    fidelityArchiveResult
  );

  const screenRecordingArchiveResult = recordScreenInFullMode
    ? await checkScreenRecording(archive)
    : { ok: true, skipped: "screen-recording-e2e-disabled" };
  assert(
    screenRecordingArchiveResult.ok,
    "Exported archive missing screen recording evidence",
    screenRecordingArchiveResult
  );

  const sourceMapResult = verifySourceMaps
    ? await verifyScriptSourceMapEvidence(exportedPath)
    : { ok: true, skipped: "lite-mode-records-no-source-maps-by-default" };
  assert(
    sourceMapResult.ok,
    "Exported archive missing script source map evidence",
    sourceMapResult
  );

  const screenshotResult =
    captureMode !== "full"
      ? { ok: true, skipped: "lite-screenshot-not-required" }
      : recordScreenInFullMode && !captureScreenshotsInFullMode
        ? await checkScreenshots(archive, { expected: false })
        : captureScreenshotsInFullMode
          ? await checkScreenshots(archive, { expected: true })
          : { ok: true, skipped: "screenshots-disabled" };
  assert(
    screenshotResult.ok,
    "Exported archive screenshots do not match the visual capture setting",
    screenshotResult
  );

  const responseBodyResult = bodiesRequested
    ? await checkResponseBodyPreview(archive, { urlIncludes: "/api/" })
    : { ok: true, skipped: "bodies-not-requested" };
  assert(responseBodyResult.ok, "Exported archive has no readable API response body", {
    responseBodyResult
  });

  // Every body the policy asked for is in the archive or carries the reason it is not.
  const completenessResult = completenessMode
    ? checkCompleteness(
        archive,
        realisticCompletenessExpectations(scenarioResult, { reloadAfterStart })
      )
    : bodiesRequested
      ? checkCompleteness(archive, {
          maxMissingResponseBodies: 0,
          maxMissingRequestBodies: 0,
          maxInternalRequests: 0
        })
      : { ok: true, skipped: "bodies-not-requested" };
  const trafficResult = completenessMode
    ? checkRealisticTraffic(archive, scenarioResult)
    : { ok: true, skipped: "demo-scenario" };
  assert(trafficResult.ok, "Exported archive misses requests the page sent", trafficResult);
  const duplicatedContentTypeResult = completenessMode
    ? checkDuplicatedContentTypeBody(archive)
    : { ok: true, skipped: "demo-scenario" };
  assert(
    duplicatedContentTypeResult.ok,
    "Exported archive left out a body sent with a duplicated Content-Type",
    duplicatedContentTypeResult
  );
  assert(completenessResult.ok, "Exported archive lost bodies silently", {
    failures: completenessResult.failures,
    report: completenessResult.lines
  });

  const playerTarget = await openTarget(baseUrl, playerUrl);
  state.openedTargetIds.push(playerTarget.id);

  const playerClient = new CdpClient(playerTarget.webSocketDebuggerUrl, cdpClientOptions);
  await playerClient.connect();
  await playerClient.send("Runtime.enable");
  await playerClient.send("DOM.enable");
  state.playerClient = playerClient;

  const playerExceptions = [];
  playerClient.on("Runtime.exceptionThrown", (params) => {
    playerExceptions.push({
      text: params?.exceptionDetails?.text ?? "unknown",
      line: params?.exceptionDetails?.lineNumber ?? null
    });
  });

  await waitForPlayerReady(playerClient, 20_000);
  const playerResult = await runPlayerSmoke({
    playerClient,
    archivePath: exportedPath,
    passphrase: exportPassphrase,
    timeoutMs: 35_000
  });
  assert(playerResult.ok, "Player did not open the archive and list its events", playerResult);

  if (swExceptions.length > 0) {
    throw new Error(`Service worker runtime exceptions: ${JSON.stringify(swExceptions)}`);
  }

  if (demoExceptions.length > 0) {
    throw new Error(`Demo page runtime exceptions: ${JSON.stringify(demoExceptions)}`);
  }

  if (playerExceptions.length > 0) {
    throw new Error(`Player page runtime exceptions: ${JSON.stringify(playerExceptions)}`);
  }

  // Read before the restart check: a new worker starts its totals from zero.
  const portTraffic = state.swClient
    ? summarizePortTraffic(await readPortTrafficStats(state.swClient).catch(() => null))
    : null;

  const restartResult = realWorldScenario.includes("restart")
    ? await verifyExtensionRestart(control, baseUrl, extensionId)
    : { ok: true, skipped: true };
  assert(restartResult.ok, "Extension restart verification failed", restartResult);

  console.log("Demo URL:", demoUrl);
  console.log("Player URL:", playerUrl);
  console.log("Capture mode:", captureMode);
  console.log("Capture fidelity (archive):", JSON.stringify(fidelityArchiveResult));
  console.log("Full visual capture:", fullVisualCapture);
  console.log("Record screen:", recordScreenInFullMode);
  console.log("Capture screenshots:", captureScreenshotsInFullMode);
  console.log("Recorder options:", JSON.stringify(recorderConfigured));
  console.log(
    "Popup actions:",
    control.kind === "popup" ? (control.useUiActions ? "ui" : "runtime") : control.kind
  );
  console.log("Reload after start:", reloadAfterStart);
  console.log("Injection:", JSON.stringify(injectionSetup));
  console.log("Session:", sid);
  console.log("Export:", exportStatus.text);
  console.log("Archive:", exportedPath);
  console.log("Archive bytes:", fileInfo.size);
  console.log("Scenario:", JSON.stringify(scenarioResult));
  console.log("Real-world scenario:", JSON.stringify(realWorldResult));
  console.log("Archive basics:", JSON.stringify(archiveBasics));
  console.log("Real-world archive evidence:", JSON.stringify(archiveEvidenceResult));
  console.log("Screen recording archive evidence:", JSON.stringify(screenRecordingArchiveResult));
  console.log("Source maps:", JSON.stringify(sourceMapResult));
  console.log("Screenshots:", JSON.stringify(screenshotResult));
  console.log("Response body:", JSON.stringify(responseBodyResult));
  console.log("Realistic traffic:", JSON.stringify(trafficResult));
  if (completenessResult.lines) {
    console.log(["Capture completeness:", ...completenessResult.lines].join("\n"));
  }
  console.log("Port traffic (SW<->offscreen):", JSON.stringify(portTraffic));
  console.log("Player smoke:", JSON.stringify(playerResult));
  console.log("Extension restart:", JSON.stringify(restartResult));
  console.log(`Chrome log: ${chromeLogPath}`);
  console.log("Fullchain E2E passed.");

  await cleanup();
}

/** Logs an error thrown inside the minified demo bundle (captured as a console stack). */
async function logMinifiedBundleError(demoClient) {
  return demoClient.evaluate(`
    (() => {
      if (!window.wbStackDemo) {
        return { ok: false, reason: 'bundle-not-loaded' };
      }

      try {
        window.wbStackDemo.failCheckout();
        return { ok: false, reason: 'did-not-throw' };
      } catch (error) {
        console.error(error);
        return { ok: true, firstFrame: String(error.stack).split('\\n')[1]?.trim() ?? null };
      }
    })()
  `);
}

/**
 * The archive records the minified demo bundle's source map reference (Full mode records
 * references by default), and the logged stack maps back to the bundle's original source.
 */
async function verifyScriptSourceMapEvidence(archivePath) {
  const sdk = await import(pathToFileURL(playerSdkEntry).href);
  const player = await sdk.WebBlackboxPlayer.open(new Uint8Array(await readFile(archivePath)), {
    passphrase: exportPassphrase || undefined
  });
  const scripts = [
    ...sdk.collectScriptSourceMaps(player.query({ types: ["sys.script"] })).values()
  ];
  const bundle = scripts.find((entry) => entry.script.endsWith("/demo/vendor/checkout.min.js"));
  const errorEvent = player.events.find(
    (event) =>
      event.type === "console.entry" &&
      sdk.extractEventStack(event).some((frame) => frame.url.includes("checkout.min.js"))
  );
  const mapPath = resolve(demoDir, "vendor", "checkout.min.js.map");
  const symbolicator = sdk.createArchiveSymbolicator(player, [
    sdk.createSourceMapFileProvider([
      { path: "vendor/checkout.min.js.map", load: () => readFile(mapPath) }
    ])
  ]);
  const frames = errorEvent
    ? await symbolicator.symbolicateFrames(sdk.extractEventStack(errorEvent))
    : [];
  const top = frames[0];

  return {
    ok:
      bundle?.sourceMap?.endsWith("/demo/vendor/checkout.min.js.map") === true &&
      top?.status === "mapped" &&
      top.original?.source.endsWith("vendor-src/checkout.js") === true &&
      top.original?.line === 9,
    scripts: scripts.map((entry) => ({ script: entry.script, sourceMap: entry.sourceMap })),
    errorEventId: errorEvent?.id ?? null,
    topFrame: top
      ? { raw: top.frame.raw, status: top.status, original: top.original, error: top.error }
      : null
  };
}

async function ensureBuildInputs() {
  await access(extensionDir, constants.R_OK);
  await access(resolve(extensionDir, "manifest.json"), constants.R_OK);
  await access(resolve(extensionDir, "sw.js"), constants.R_OK);

  await access(demoDir, constants.R_OK);
  await access(resolve(demoDir, "index.html"), constants.R_OK);
  await access(resolve(demoDir, "app.js"), constants.R_OK);

  await access(playerDir, constants.R_OK);
  await access(resolve(playerDir, "index.html"), constants.R_OK);
  await access(resolve(playerDir, "main.js"), constants.R_OK);
}

async function prepareScreenRecordingE2eExtensionDir(sourceDir) {
  const tempDir = `/tmp/webblackbox-ext-fullchain-extension-${Date.now()}`;
  await rm(tempDir, { recursive: true, force: true });
  await cp(sourceDir, tempDir, { recursive: true });

  const manifestPath = resolve(tempDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.commands = {
    ...(manifest.commands && typeof manifest.commands === "object" ? manifest.commands : {}),
    _execute_action: {
      suggested_key: {
        default: "Alt+Shift+Y",
        mac: "Alt+Shift+Y"
      }
    }
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return tempDir;
}

function assertCommandLineExtensionLoadingSupported(binary, browserVersion) {
  const major = Number(/^Chrome\/(\d+)/u.exec(browserVersion ?? "")?.[1] ?? "0");
  const normalizedBinary = String(binary).replaceAll("\\", "/").toLowerCase();
  const isChromeForTesting = normalizedBinary.includes("chrome for testing");
  const isChromium = normalizedBinary.includes("chromium");
  const isMacBrandedChrome = normalizedBinary.includes("/applications/google chrome.app/");

  if (major >= 137 && isMacBrandedChrome && !isChromeForTesting && !isChromium) {
    throw new Error(
      [
        "This E2E requires a browser that still supports command-line unpacked extensions.",
        "Official Chrome branded builds block --load-extension starting with Chrome 137.",
        "Set WB_E2E_CHROME_BIN to Chrome for Testing or Chromium."
      ].join(" ")
    );
  }
}

async function startDemoServer({ demoDir, playerDir, artifactsDir }) {
  const tasks = [];

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const pathname = decodeURIComponent(requestUrl.pathname);

      if (pathname === "/") {
        redirect(response, "/demo/");
        return;
      }

      if (serveFidelityImage(pathname, response)) {
        return;
      }

      if (pathname.startsWith("/api/")) {
        await handleApiRequest(request, response, requestUrl, tasks);
        return;
      }

      if (pathname === "/demo") {
        redirect(response, "/demo/");
        return;
      }

      if (pathname.startsWith("/demo/")) {
        const relativePath = pathname.slice("/demo/".length) || "index.html";
        await serveStatic(response, demoDir, relativePath);
        return;
      }

      if (pathname === "/player") {
        redirect(response, "/player/");
        return;
      }

      if (pathname.startsWith("/player/")) {
        const relativePath = pathname.slice("/player/".length) || "index.html";
        await serveStatic(response, playerDir, relativePath);
        return;
      }

      if (pathname.startsWith("/artifacts/")) {
        const relativePath = pathname.slice("/artifacts/".length);
        await serveStatic(response, artifactsDir, relativePath);
        return;
      }

      writeJson(response, 404, {
        ok: false,
        error: "not-found",
        path: pathname
      });
    } catch (error) {
      writeJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve local demo server address.");
  }

  return {
    server,
    port: address.port,
    fidelitySockets: attachFidelitySocketServer(server)
  };
}

async function handleApiRequest(request, response, requestUrl, tasks) {
  const pathname = requestUrl.pathname;

  if (pathname === "/api/dashboard" && request.method === "GET") {
    writeJson(response, 200, {
      ok: true,
      view: requestUrl.searchParams.get("view") ?? "default",
      generatedAt: new Date().toISOString(),
      totals: {
        open: tasks.length,
        completed: 0
      },
      tasks: tasks.slice(-10)
    });
    return;
  }

  if (pathname === "/api/slow-report" && request.method === "GET") {
    const rawDelay = Number(requestUrl.searchParams.get("delay") ?? "600");
    const delay = Number.isFinite(rawDelay) ? Math.max(150, Math.min(rawDelay, 2_000)) : 600;
    await sleep(delay);

    writeJson(response, 200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      delayMs: delay,
      report: {
        p95: 312,
        p99: 640,
        errorRate: 0.013
      }
    });
    return;
  }

  // `/api/large-response[/<source>]`: the source is in the path because recorded URLs drop the
  // query string.
  if (pathname.startsWith("/api/large-response") && request.method === "GET") {
    const rawBytes = Number(requestUrl.searchParams.get("bytes") ?? realWorldLargeResponseBytes);
    const size = Number.isFinite(rawBytes)
      ? Math.max(1024, Math.min(rawBytes, 4 * 1024 * 1024))
      : 1024;
    const payload = {
      ok: true,
      kind: "real-world-large-response",
      bytes: size,
      data: "x".repeat(Math.max(0, size - 96))
    };

    writeJson(response, 200, payload);
    return;
  }

  if (pathname === "/api/fail" && request.method === "GET") {
    const rawStatus = Number(requestUrl.searchParams.get("code") ?? "503");
    const status = Number.isFinite(rawStatus) ? Math.max(400, Math.min(rawStatus, 599)) : 503;

    writeJson(response, status, {
      ok: false,
      code: status,
      reason: "synthetic-upstream-failure"
    });
    return;
  }

  if (pathname === "/api/tasks" && request.method === "POST") {
    const bodyText = await readRequestBody(request, 512_000);
    let body;

    try {
      body = bodyText.length > 0 ? JSON.parse(bodyText) : {};
    } catch {
      writeJson(response, 400, {
        ok: false,
        error: "invalid-json"
      });
      return;
    }

    const title =
      typeof body?.title === "string" && body.title.trim().length > 0
        ? body.title.trim()
        : `Task ${tasks.length + 1}`;

    const task = {
      id: `task-${tasks.length + 1}`,
      title,
      source: typeof body?.source === "string" ? body.source : "unknown",
      createdAt: new Date().toISOString()
    };

    tasks.push(task);

    writeJson(response, 201, {
      ok: true,
      task,
      total: tasks.length
    });
    return;
  }

  writeJson(response, 404, {
    ok: false,
    error: "api-route-not-found",
    path: pathname,
    method: request.method
  });
}

function writeJson(response, status, payload) {
  const bytes = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": bytes.byteLength
  });
  response.end(bytes);
}

function redirect(response, location) {
  response.writeHead(302, {
    location,
    "cache-control": "no-store"
  });
  response.end();
}

async function readRequestBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    request.on("data", (chunk) => {
      total += chunk.byteLength;

      if (total > maxBytes) {
        reject(new Error(`Request body exceeds ${maxBytes} bytes.`));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    request.on("error", (error) => {
      reject(error);
    });
  });
}

async function serveStatic(response, rootDir, relativePath) {
  const safeRelative = normalizeRelativePath(relativePath);
  const resolved = resolve(rootDir, safeRelative);
  const guardedRoot = rootDir.endsWith(sep) ? rootDir : `${rootDir}${sep}`;

  if (resolved !== rootDir && !resolved.startsWith(guardedRoot)) {
    writeJson(response, 403, {
      ok: false,
      error: "path-traversal"
    });
    return;
  }

  let filePath = resolved;

  try {
    const info = await stat(filePath);

    if (info.isDirectory()) {
      filePath = resolve(filePath, "index.html");
    }
  } catch {
    writeJson(response, 404, {
      ok: false,
      error: "asset-not-found",
      path: relativePath
    });
    return;
  }

  let bytes;

  try {
    bytes = await readFile(filePath);
  } catch {
    writeJson(response, 404, {
      ok: false,
      error: "asset-not-found",
      path: relativePath
    });
    return;
  }

  response.writeHead(200, {
    "content-type": mimeTypeFor(filePath),
    "cache-control": "no-store",
    "content-length": bytes.byteLength
  });
  response.end(bytes);
}

function normalizeRelativePath(value) {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  return normalized.length > 0 ? normalized : "index.html";
}

function mimeTypeFor(path) {
  const extension = extname(path).toLowerCase();

  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }

  if (extension === ".js") {
    return "text/javascript; charset=utf-8";
  }

  if (extension === ".css") {
    return "text/css; charset=utf-8";
  }

  if (extension === ".json" || extension === ".map") {
    return "application/json; charset=utf-8";
  }

  if (extension === ".webblackbox" || extension === ".zip") {
    return "application/zip";
  }

  if (extension === ".svg") {
    return "image/svg+xml";
  }

  if (extension === ".png") {
    return "image/png";
  }

  return "application/octet-stream";
}

async function waitForExtensionServiceWorker(urlBase, timeoutMs, extensionId) {
  const extensionPrefix = extensionId
    ? `chrome-extension://${extensionId}/`
    : "chrome-extension://";
  let lastTargetSummary = "none";

  try {
    return await waitFor(
      async () => {
        const targets = await fetchJson(`${urlBase}/json/list`, 4_000);

        if (!Array.isArray(targets)) {
          return null;
        }

        lastTargetSummary = summarizeTargetsForDebug(targets);

        return (
          targets.find(
            (target) =>
              target?.type === "service_worker" &&
              typeof target?.url === "string" &&
              target.url.startsWith(extensionPrefix) &&
              target.url.endsWith("/sw.js")
          ) ?? null
        );
      },
      timeoutMs,
      250,
      "Extension service worker target not found"
    );
  } catch (error) {
    throw new Error(
      `Extension service worker target not found for prefix '${extensionPrefix}'. Targets: ${lastTargetSummary}. ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function waitForExtensionIdFromProfile(urlBase, profileDir, extensionDir, timeoutMs) {
  const normalizedExtensionDir = normalizeFsPath(extensionDir);
  const retryProbeAfterMs = 3_000;
  const nextProbeAtById = new Map();

  return waitFor(
    async () => {
      const idFromSettings = await readExtensionIdFromProfile(profileDir, normalizedExtensionDir);

      if (idFromSettings) {
        return idFromSettings;
      }

      const candidateIds = new Set([
        ...(await readExtensionIdsFromProfile(profileDir)),
        ...(await readExtensionIdsFromLocalSettings(profileDir)),
        ...(await readExtensionIdsFromTargets(urlBase))
      ]);

      if (candidateIds.size === 0) {
        return null;
      }

      const now = Date.now();

      for (const candidateId of candidateIds) {
        const nextProbeAt = nextProbeAtById.get(candidateId) ?? 0;

        if (nextProbeAt > now) {
          continue;
        }

        const matched = await probeExtensionPopup(urlBase, candidateId, 2_500);
        nextProbeAtById.set(candidateId, now + retryProbeAfterMs);

        if (matched) {
          return candidateId;
        }
      }

      return null;
    },
    timeoutMs,
    250,
    `Extension id not found in profile/local settings for path '${normalizedExtensionDir}'`
  );
}

async function readExtensionIdFromProfile(profileDir, normalizedExtensionDir) {
  for (const fileName of ["Secure Preferences", "Preferences"]) {
    const path = resolve(profileDir, "Default", fileName);
    let content;

    try {
      content = await readFile(path, "utf8");
    } catch {
      continue;
    }

    let parsed;

    try {
      parsed = JSON.parse(content);
    } catch {
      continue;
    }

    const settings = parsed?.extensions?.settings;

    if (!settings || typeof settings !== "object") {
      continue;
    }

    for (const [candidateId, candidateValue] of Object.entries(settings)) {
      if (!isLikelyExtensionId(candidateId)) {
        continue;
      }

      if (!candidateValue || typeof candidateValue !== "object") {
        continue;
      }

      const pathValue =
        typeof candidateValue.path === "string" ? normalizeFsPath(candidateValue.path) : null;

      if (!pathValue) {
        continue;
      }

      if (pathsLikelyEqual(pathValue, normalizedExtensionDir)) {
        return candidateId;
      }
    }
  }

  return null;
}

async function readExtensionIdsFromProfile(profileDir) {
  const ids = new Set();

  for (const fileName of ["Secure Preferences", "Preferences"]) {
    const path = resolve(profileDir, "Default", fileName);
    let content;

    try {
      content = await readFile(path, "utf8");
    } catch {
      continue;
    }

    let parsed;

    try {
      parsed = JSON.parse(content);
    } catch {
      continue;
    }

    const settings = parsed?.extensions?.settings;

    if (!settings || typeof settings !== "object") {
      continue;
    }

    for (const candidateId of Object.keys(settings)) {
      if (isLikelyExtensionId(candidateId)) {
        ids.add(candidateId);
      }
    }
  }

  return [...ids];
}

async function readExtensionIdsFromLocalSettings(profileDir) {
  const settingsDir = resolve(profileDir, "Default", "Local Extension Settings");
  let entries;

  try {
    entries = await readdir(settingsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory() && isLikelyExtensionId(entry.name))
    .map((entry) => entry.name);
}

async function readExtensionIdsFromTargets(urlBase) {
  let targets;

  try {
    targets = await fetchJson(`${urlBase}/json/list`, 4_000);
  } catch {
    return [];
  }

  if (!Array.isArray(targets)) {
    return [];
  }

  const ids = new Set();

  for (const target of targets) {
    const url = typeof target?.url === "string" ? target.url : "";
    const match = /^chrome-extension:\/\/([^/]+)\//.exec(url);

    if (match && isLikelyExtensionId(match[1])) {
      ids.add(match[1]);
    }
  }

  return [...ids];
}

async function probeExtensionPopup(urlBase, extensionId, timeoutMs) {
  let target = null;
  let popupClient = null;

  try {
    target = await openTarget(urlBase, `chrome-extension://${extensionId}/popup.html`);

    popupClient = new CdpClient(target.webSocketDebuggerUrl, cdpClientOptions);
    await popupClient.connect();
    await popupClient.send("Runtime.enable");
    await popupClient.send("DOM.enable").catch(() => undefined);

    const ready = await waitFor(
      async () => {
        const snapshot = await popupClient.evaluate(`
          (() => {
            const title = (document.querySelector('.wb-popup__title')?.textContent ?? '').trim();
            const hasStart = Boolean(document.querySelector("[data-action='start']"));
            const runtimeId =
              typeof chrome === "object" &&
              chrome !== null &&
              typeof chrome.runtime === "object" &&
              chrome.runtime !== null &&
              typeof chrome.runtime.id === "string"
                ? chrome.runtime.id
                : null;

            return {
              title,
              hasStart,
              runtimeId
            };
          })()
        `);

        const isPopupReady =
          snapshot &&
          snapshot.title === "WebBlackbox" &&
          snapshot.hasStart === true &&
          snapshot.runtimeId === extensionId;

        return isPopupReady ? snapshot : null;
      },
      timeoutMs,
      150,
      `Popup probe timed out for extension '${extensionId}'`
    ).catch(() => null);

    return Boolean(ready);
  } catch {
    return false;
  } finally {
    if (popupClient) {
      popupClient.close();
    }

    if (target?.id) {
      await closeTarget(urlBase, target.id);
    }
  }
}

function normalizeFsPath(value) {
  return resolve(String(value)).replaceAll("\\", "/").replace(/\/+$/g, "");
}

function pathsLikelyEqual(left, right) {
  return left === right || left.toLowerCase() === right.toLowerCase();
}

async function openActionPopupFromShortcut(urlBase, pageClient, extensionId) {
  const targetsBefore = await listTargets(urlBase);
  const knownTargetIds = new Set(
    targetsBefore
      .map((target) => target?.id)
      .filter((id) => typeof id === "string" && id.length > 0)
  );

  await pageClient.send("Page.bringToFront").catch(() => undefined);
  await pageClient
    .evaluate(
      `
        (() => {
          window.focus();
          return true;
        })()
      `
    )
    .catch(() => undefined);
  await sleep(250);
  await dispatchExtensionActionShortcut(pageClient);

  return waitForExtensionPopupTarget(urlBase, extensionId, knownTargetIds, 10_000);
}

async function dispatchExtensionActionShortcut(pageClient) {
  const event = {
    key: "Y",
    code: "KeyY",
    windowsVirtualKeyCode: 89,
    nativeVirtualKeyCode: 89,
    altKey: true,
    shiftKey: true,
    modifiers: 9
  };

  await pageClient.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    ...event
  });
  await pageClient.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    ...event
  });
}

async function waitForExtensionPopupTarget(urlBase, extensionId, knownTargetIds, timeoutMs) {
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  let lastTargetSummary = "none";

  return waitFor(
    async () => {
      const targets = await listTargets(urlBase);
      lastTargetSummary = summarizeTargetsForDebug(targets);

      return (
        targets.find(
          (target) =>
            typeof target?.id === "string" &&
            !knownTargetIds.has(target.id) &&
            typeof target?.webSocketDebuggerUrl === "string" &&
            typeof target?.url === "string" &&
            target.url.startsWith(popupUrl)
        ) ??
        targets.find(
          (target) =>
            typeof target?.webSocketDebuggerUrl === "string" &&
            typeof target?.url === "string" &&
            target.url.startsWith(popupUrl)
        ) ??
        null
      );
    },
    timeoutMs,
    150,
    () => `Extension action popup did not open from shortcut; targets=${lastTargetSummary}`
  );
}

function createRuntimeContextTracker(client) {
  const contexts = new Map();

  client.on("Runtime.executionContextCreated", (params) => {
    const context = params?.context;

    if (context && typeof context.id === "number") {
      contexts.set(context.id, context);
    }
  });

  client.on("Runtime.executionContextDestroyed", (params) => {
    const id = params?.executionContextId;

    if (typeof id === "number") {
      contexts.delete(id);
    }
  });

  client.on("Runtime.executionContextsCleared", () => {
    contexts.clear();
  });

  return {
    list() {
      return [...contexts.values()];
    }
  };
}

async function waitForExtensionRuntimeContext(pageClient, tracker, extensionId, timeoutMs) {
  let lastSnapshot = null;

  try {
    return await waitFor(
      async () => {
        const contexts = tracker.list().filter((context) => {
          const origin = typeof context.origin === "string" ? context.origin : "";
          const name = typeof context.name === "string" ? context.name : "";
          const auxData =
            context.auxData && typeof context.auxData === "object" ? context.auxData : {};
          const type = typeof auxData.type === "string" ? auxData.type : "";

          return (
            type === "isolated" ||
            origin.startsWith(`chrome-extension://${extensionId}`) ||
            name.includes(extensionId) ||
            name.includes("WebBlackbox")
          );
        });

        for (const context of contexts) {
          const snapshot = await pageClient
            .evaluate(
              `
                (() => {
                  const chromeApi =
                    typeof chrome === "object" && chrome !== null ? chrome : null;
                  const runtime = chromeApi?.runtime ?? null;
                  return {
                    contextId: ${JSON.stringify(context.id)},
                    contextName: ${JSON.stringify(context.name ?? "")},
                    contextOrigin: ${JSON.stringify(context.origin ?? "")},
                    url: location.href,
                    runtimeId:
                      runtime && typeof runtime.id === "string" ? runtime.id : null,
                    hasRuntimeMessaging:
                      runtime !== null && typeof runtime.sendMessage === "function",
                    hasStorageLocal:
                      typeof chromeApi?.storage?.local?.get === "function"
                  };
                })()
              `,
              { contextId: context.id }
            )
            .catch((error) => ({
              contextId: context.id,
              error: error instanceof Error ? error.message : String(error)
            }));

          lastSnapshot = snapshot;

          if (
            snapshot?.hasRuntimeMessaging &&
            (snapshot.runtimeId === extensionId || typeof snapshot.runtimeId === "string")
          ) {
            return {
              contextId: context.id,
              snapshot
            };
          }
        }

        return null;
      },
      timeoutMs,
      200,
      "Extension runtime context not ready"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const contextSummary = tracker
      .list()
      .map((context) => ({
        id: context.id,
        name: context.name,
        origin: context.origin,
        auxData: context.auxData
      }))
      .slice(0, 12);
    throw new Error(
      `${message}; lastSnapshot=${JSON.stringify(lastSnapshot)}; contexts=${JSON.stringify(
        contextSummary
      )}`
    );
  }
}

async function evaluateControl(control, expression) {
  try {
    return await control.client.evaluate(
      expression,
      typeof control.contextId === "number" ? { contextId: control.contextId } : undefined
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const canRefreshContext =
      control.kind === "content-runtime" &&
      control.contextTracker &&
      control.extensionId &&
      /Cannot find context|Execution context|Cannot find object with id/u.test(message);

    if (!canRefreshContext) {
      throw error;
    }

    const runtimeContext = await waitForExtensionRuntimeContext(
      control.client,
      control.contextTracker,
      control.extensionId,
      10_000
    );
    control.contextId = runtimeContext.contextId;

    return control.client.evaluate(expression, { contextId: control.contextId });
  }
}

/**
 * Switches the extension to injection on Start, waits until the all-sites registration is gone,
 * reloads the demo page and checks that no content script runs in it before Start.
 */
async function switchToOnDemandInjection(control, demoClient, demoContexts, extensionId) {
  const remaining = await evaluateControl(
    control,
    `
      (async () => {
        await chrome.storage.local.set({ 'webblackbox.injection': 'on-start' });
        const deadline = Date.now() + 10000;

        while (Date.now() < deadline) {
          const scripts = await chrome.scripting.getRegisteredContentScripts();

          if (!scripts.some((script) => script.id === 'webblackbox-content')) {
            return [];
          }

          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        return (await chrome.scripting.getRegisteredContentScripts()).map((script) => script.id);
      })()
    `
  );

  if (!Array.isArray(remaining) || remaining.length > 0) {
    return { ok: false, reason: "registration-kept", remaining };
  }

  await demoClient.send("Page.reload", { ignoreCache: true });
  await waitFor(
    () => demoClient.evaluate("document.readyState === 'complete' || null"),
    15_000,
    200,
    "Demo page did not finish reloading"
  );
  await sleep(1_000);

  const frames = await listContentScriptContexts(demoClient, demoContexts, extensionId);

  return frames.length === 0
    ? { ok: true, mode: "on-start", framesBeforeStart: 0 }
    : { ok: false, reason: "content-script-before-start", frames };
}

/** Isolated-world contexts of this extension in which content.js has started. */
async function listContentScriptContexts(pageClient, tracker, extensionId) {
  const found = [];

  for (const context of tracker.list()) {
    if (context?.auxData?.type !== "isolated") {
      continue;
    }

    const running = await pageClient
      .evaluate(
        `(() => chrome?.runtime?.id === ${JSON.stringify(extensionId)} &&
          typeof globalThis.__webblackboxContentScript__?.isAlive === 'function')()`,
        { contextId: context.id }
      )
      .catch(() => false);

    if (running === true) {
      found.push({ contextId: context.id, frameId: context.auxData?.frameId ?? null });
    }
  }

  return found;
}

/**
 * Sampling of the configured e2e options. The completeness gate uses what the Full capture profile
 * records with (1 MiB bodies, a 30 s DOM snapshot interval, 12 s screenshots), not the fast
 * test values that hid losses: a 1 s snapshot interval and 64 KiB bodies.
 */
function resolveE2eSampling(mode) {
  if (completenessMode) {
    return {
      mousemoveHz: 60,
      scrollHz: 10,
      domFlushMs: 180,
      screenshotIdleMs: 12_000,
      snapshotIntervalMs: 30_000,
      actionWindowMs: 1500,
      bodyCaptureMaxBytes: 1024 * 1024
    };
  }

  return {
    mousemoveHz: 20,
    scrollHz: 15,
    domFlushMs: 100,
    screenshotIdleMs: mode === "full" ? 600 : 0,
    snapshotIntervalMs: 1000,
    actionWindowMs: 1500,
    bodyCaptureMaxBytes: mode === "full" ? 65536 : 32768
  };
}

async function configureE2eRecorderOptions(control, mode) {
  return evaluateControl(
    control,
    `
      (async () => {
        const chromeApi = typeof chrome === 'object' && chrome !== null ? chrome : null;

        if (typeof chromeApi?.storage?.local?.set !== 'function') {
          return { ok: false, reason: 'storage-api-unavailable' };
        }

        const capturePolicy = {
          schemaVersion: 2,
          mode: 'lab',
          captureContext: 'synthetic',
          captureContextEvidenceRef: 'synthetic:e2e-fullchain',
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
            screenshots: ${JSON.stringify(captureScreenshotsInFullMode)} ? 'allow' : 'off',
            screenRecordings: ${JSON.stringify(recordScreenInFullMode)} ? 'allow' : 'off',
            console: 'allow',
            network: 'body-allowlist',
            storage: 'allow',
            indexedDb: 'names-only',
            cookies: 'names-only',
            cdp: ${JSON.stringify(mode)} === 'full' ? 'full' : 'safe-subset',
            heapProfiles: 'off'
          },
          redaction: {
            redactHeaders: [
              'authorization',
              'cookie',
              'set-cookie',
              'proxy-authorization',
              'x-api-key',
              'x-auth-token',
              'x-csrf-token',
              'x-xsrf-token'
            ],
            redactCookieNames: ['token', 'session', 'auth', 'jwt', 'refresh_token', 'csrf', 'xsrf'],
            redactBodyPatterns: [
              'password',
              'token',
              'secret',
              'otp',
              'credential',
              'api_key',
              'apikey',
              'private_key',
              'refresh_token'
            ],
            blockedSelectors: [
              '.secret',
              '[data-sensitive]',
              '[data-webblackbox-redact]',
              "input[type='password']",
              "input[name*='token']",
              "input[name*='secret']",
              "input[autocomplete='cc-number']"
            ],
            hashSensitiveValues: true
          },
          encryption: {
            localAtRest: 'required',
            archive: 'required',
            archiveKeyEnvelope: 'passphrase'
          },
          retention: {
            localTtlMs: 24 * 60 * 60 * 1000
          }
        };

        await chromeApi.storage.local.set({
          'webblackbox.options': {
            optionsVersion: 1,
            mode: ${JSON.stringify(mode)},
            freezeOnNetworkFailure: false,
            freezeOnLongTaskSpike: false,
            sampling: ${JSON.stringify(resolveE2eSampling(mode))},
            capturePolicy
          }
        });

        return {
          ok: true,
          mode: ${JSON.stringify(mode)},
          cdp: capturePolicy.categories.cdp,
          screenshots: capturePolicy.categories.screenshots,
          screenRecordings: capturePolicy.categories.screenRecordings,
          screenshotIdleMs: ${JSON.stringify(resolveE2eSampling(mode).screenshotIdleMs)}
        };
      })()
    `
  );
}

async function startSessionFromControl(control, mode, expectedUrl, options = {}) {
  const visualCapture = mode === "full" ? (options.visualCapture ?? "screenshots") : null;

  if (control.kind === "popup") {
    return startSessionFromPopup(control.client, mode, expectedUrl, control.useUiActions, {
      ...options,
      visualCapture
    });
  }

  return evaluateControl(
    control,
    `
      (async () => {
        const chromeApi = typeof chrome === 'object' && chrome !== null ? chrome : null;
        if (typeof chromeApi?.runtime?.sendMessage !== 'function') {
          return { ok: false, reason: 'runtime-api-unavailable' };
        }

        const response = await chromeApi.runtime.sendMessage({
          kind: 'ui.start',
          mode: ${JSON.stringify(mode)},
          visualCapture: ${JSON.stringify(visualCapture)}
        });

        if (response && typeof response === 'object' && response.ok === false) {
          return {
            ok: false,
            reason: 'runtime-start-rejected',
            response
          };
        }

        return { ok: true, mode: ${JSON.stringify(mode)}, via: 'content-runtime' };
      })()
    `
  );
}

async function startSessionFromPopup(popupClient, mode, expectedUrl, useUiActions, options = {}) {
  const visualCapture = mode === "full" ? (options.visualCapture ?? "screenshots") : null;

  if (useUiActions) {
    const expression = `
      (async () => {
        const selector = "[data-action='start']";
        const visualCapture = ${JSON.stringify(visualCapture)};
        const tabLine = (document.querySelector('.wb-popup__tab')?.textContent ?? '').trim() || null;
        const statusLine =
          (document.querySelector('.wb-popup__state')?.textContent ?? '').trim() || null;
        const engineInput = document.querySelector(
          'input[name="capture-mode"][value=${JSON.stringify(mode)}]'
        );

        if (!(engineInput instanceof HTMLInputElement)) {
          return { ok: false, reason: 'engine-option-not-found', selector, tabLine, statusLine };
        }

        // Picking the engine re-renders the start panel; query the button afterwards.
        engineInput.checked = true;
        engineInput.dispatchEvent(new Event('change', { bubbles: true }));
        const button = document.querySelector(selector);

        if (!(button instanceof HTMLButtonElement)) {
          return { ok: false, reason: 'start-button-not-found', selector, tabLine, statusLine };
        }

        if (button.disabled) {
          return { ok: false, reason: 'start-button-disabled', selector, tabLine, statusLine };
        }

        if (visualCapture) {
          const visualCaptureInput = document.querySelector(
            \`input[name='full-visual-capture'][value='\${visualCapture}']\`
          );

          if (!(visualCaptureInput instanceof HTMLInputElement)) {
            return { ok: false, reason: 'visual-capture-option-not-found', visualCapture, selector, tabLine, statusLine };
          }

          visualCaptureInput.checked = true;
          visualCaptureInput.dispatchEvent(new Event('change', { bubbles: true }));
        }

        button.click();
        // Start asks whether to reload the page first, in both engines. Lite keeps its reload
        // (page startup); Full starts on the loaded page, as the run's later checks expect.
        const choiceSelector =
          ${JSON.stringify(mode)} === 'lite'
            ? "[data-action='start-reload']"
            : "[data-action='start-direct']";
        const choiceButton = await new Promise((resolve) => {
          const startedAt = Date.now();
          const tick = () => {
            const candidate = document.querySelector(choiceSelector);

            if (candidate instanceof HTMLButtonElement || Date.now() - startedAt > 5000) {
              resolve(candidate);
              return;
            }

            setTimeout(tick, 50);
          };

          tick();
        });

        if (!(choiceButton instanceof HTMLButtonElement)) {
          return {
            ok: false,
            reason: 'start-reload-question-not-found',
            selector: choiceSelector,
            tabLine,
            statusLine
          };
        }

        choiceButton.click();
        return {
          ok: true,
          mode: ${JSON.stringify(mode)},
          visualCapture,
          via: 'popup-ui',
          tabLine,
          statusLine
        };
      })()
    `;

    return popupClient.evaluate(expression);
  }

  const expression = `
    (async () => {
      if (typeof chrome?.tabs?.query === 'function') {
        const tabs = await chrome.tabs.query({});
        const exact = tabs.find((tab) =>
          typeof tab.id === 'number' &&
          typeof tab.url === 'string' &&
          tab.url.startsWith(${JSON.stringify(expectedUrl)})
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

        const response = await chrome.runtime.sendMessage({
          kind: 'ui.start',
          tabId: target.id,
          mode: ${JSON.stringify(mode)},
          visualCapture: ${JSON.stringify(visualCapture)}
        });
        if (response && typeof response === 'object' && response.ok === false) {
          return {
            ok: false,
            reason: 'runtime-start-rejected',
            tabId: target.id,
            response
          };
        }
        return {
          ok: true,
          tabId: target.id,
          mode: ${JSON.stringify(mode)},
          visualCapture: ${JSON.stringify(visualCapture)},
          via: 'runtime-tabs'
        };
      }

      const response = await chrome.runtime.sendMessage({
        kind: 'ui.start',
        mode: ${JSON.stringify(mode)},
        visualCapture: ${JSON.stringify(visualCapture)}
      });
      if (response && typeof response === 'object' && response.ok === false) {
        return {
          ok: false,
          reason: 'runtime-start-rejected',
          response
        };
      }
      return {
        ok: true,
        mode: ${JSON.stringify(mode)},
        visualCapture: ${JSON.stringify(visualCapture)},
        via: 'runtime-active-tab-fallback'
      };
    })()
  `;

  return popupClient.evaluate(expression);
}

async function stopActiveSessionFromControl(control, expectedSid) {
  if (control.kind === "popup") {
    return stopActiveSessionFromPopup(control.client, control.useUiActions, expectedSid);
  }

  return evaluateControl(
    control,
    `
      (async () => {
        const chromeApi = typeof chrome === 'object' && chrome !== null ? chrome : null;

        if (typeof chromeApi?.runtime?.sendMessage !== 'function') {
          return { ok: false, reason: 'runtime-api-unavailable' };
        }

        const store =
          typeof chromeApi?.storage?.local?.get === 'function'
            ? await chromeApi.storage.local.get('webblackbox.runtime.sessions')
            : {};
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
              via: 'content-runtime',
              rows: sessions
            };
          }

          return { ok: false, reason: 'no-active-session', rows: sessions };
        }

        const response = await chromeApi.runtime.sendMessage({
          kind: 'ui.stop',
          tabId: active.tabId
        });

        if (response && typeof response === 'object' && response.ok === false) {
          return { ok: false, reason: 'runtime-stop-rejected', response };
        }

        return { ok: true, tabId: active.tabId, via: 'content-runtime' };
      })()
    `
  );
}

async function stopActiveSessionFromPopup(popupClient, useUiActions, expectedSid) {
  if (useUiActions) {
    const expression = `
      (() => {
        const button = document.querySelector("[data-action='stop']");

        if (!(button instanceof HTMLButtonElement)) {
          if (${JSON.stringify(expectedSid)}) {
            return {
              ok: true,
              sid: ${JSON.stringify(expectedSid)},
              alreadyStopped: true,
              via: 'popup-ui'
            };
          }

          return { ok: false, reason: 'stop-button-not-found' };
        }

        if (button.disabled) {
          return { ok: false, reason: 'stop-button-disabled' };
        }

        button.click();
        return { ok: true, via: 'popup-ui' };
      })()
    `;

    return popupClient.evaluate(expression);
  }

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
            via: 'popup-runtime',
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

async function exportSessionFromControl(control, sid) {
  if (control.kind === "popup") {
    return exportSessionFromPopup(control.client, sid, control.useUiActions);
  }

  return evaluateControl(
    control,
    `
      (async () => {
        const chromeApi = typeof chrome === 'object' && chrome !== null ? chrome : null;

        if (typeof chromeApi?.runtime?.sendMessage !== 'function') {
          return { ok: false, reason: 'runtime-api-unavailable' };
        }

        const response = await chromeApi.runtime.sendMessage({
          kind: 'ui.export',
          sid: ${JSON.stringify(sid)},
          passphrase: ${JSON.stringify(exportPassphrase)},
          saveAs: false,
          policy: ${JSON.stringify(e2eExportPolicy)}
        });

        if (response && typeof response === 'object' && response.ok === false) {
          return { ok: false, reason: 'runtime-export-rejected', response };
        }

        return { ok: true, sid: ${JSON.stringify(sid)}, via: 'content-runtime' };
      })()
    `
  );
}

async function exportSessionFromPopup(popupClient, sid, useUiActions) {
  if (useUiActions) {
    const expression = `
      (() => {
        const button = document.querySelector("[data-action='export']");

        if (!(button instanceof HTMLButtonElement)) {
          return { ok: false, reason: 'export-button-not-found' };
        }

        if (button.disabled) {
          return { ok: false, reason: 'export-button-disabled' };
        }

        const previousPrompt = globalThis.prompt;

        try {
          globalThis.prompt = () => "";

          button.click();

          const passphraseInput = document.querySelector('#wb-passphrase-input');

          if (passphraseInput instanceof HTMLInputElement) {
            passphraseInput.value = ${JSON.stringify(exportPassphrase)};
            passphraseInput.dispatchEvent(new Event('input', { bubbles: true }));

            const form = passphraseInput.closest('form');

            if (form instanceof HTMLFormElement) {
              const submitButton = form.querySelector('[data-passphrase-submit]');

              if (!(submitButton instanceof HTMLButtonElement)) {
                return { ok: false, reason: 'passphrase-submit-not-found' };
              }

              submitButton.click();
              return {
                ok: true,
                sid: ${JSON.stringify(sid)},
                via: 'popup-ui',
                passphraseMode: ${JSON.stringify(exportPassphrase.length > 0 ? "provided" : "empty")}
              };
            }

            return { ok: false, reason: 'passphrase-form-not-found' };
          }
        } finally {
          globalThis.prompt = previousPrompt;
        }

        return { ok: true, sid: ${JSON.stringify(sid)}, via: 'popup-ui', flow: 'prompt-fallback' };
      })()
    `;

    return popupClient.evaluate(expression);
  }

  const expression = `
    (async () => {
      await chrome.runtime.sendMessage({
        kind: 'ui.export',
        sid: ${JSON.stringify(sid)},
        passphrase: ${JSON.stringify(exportPassphrase)},
        saveAs: false,
        policy: ${JSON.stringify(e2eExportPolicy)}
      });
      return { ok: true, sid: ${JSON.stringify(sid)} };
    })()
  `;

  return popupClient.evaluate(expression);
}

async function readRuntimeSessions(control) {
  const expression = `
    (async () => {
      const chromeApi = typeof chrome === 'object' && chrome !== null ? chrome : null;

      if (typeof chromeApi?.storage?.local?.get !== 'function') {
        return [];
      }

      const store = await chromeApi.storage.local.get('webblackbox.runtime.sessions');
      const rows = store['webblackbox.runtime.sessions'];
      return Array.isArray(rows) ? rows : [];
    })()
  `;

  return evaluateControl(control, expression);
}

async function findTabByUrlFromPopup(popupClient, expectedUrl) {
  const expression = `
    (async () => {
      const tabs = await chrome.tabs.query({});
      const match = tabs.find((tab) =>
        typeof tab.id === 'number' &&
        typeof tab.url === 'string' &&
        tab.url.startsWith(${JSON.stringify(expectedUrl)})
      );

      if (!match || typeof match.id !== 'number') {
        return null;
      }

      return {
        id: match.id,
        active: match.active === true,
        url: match.url ?? null
      };
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

      if (!status || status === previousStatus || status === "Exporting...") {
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

async function waitForExportedDownloadWithFallback(downloadClient, sid, startedAtMs, timeoutMs) {
  if (downloadClient) {
    try {
      return await waitForExportedDownload(
        downloadClient,
        sid,
        startedAtMs,
        Math.min(timeoutMs, downloadApiTimeoutMs)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Download API lookup failed; falling back to archive file scan: ${message}`);
    }
  }

  const remainingMs = Math.max(1_000, timeoutMs - (Date.now() - startedAtMs));
  return waitForExportedArchiveFile(sid, startedAtMs, remainingMs);
}

async function waitForExportedDownload(popupClient, sid, startedAtMs, timeoutMs) {
  const expression = `
    (async () => {
      const sid = ${JSON.stringify(sid)};
      const startedAtMs = ${JSON.stringify(startedAtMs)};
      const rows = await chrome.downloads.search({
        orderBy: ['-startTime'],
        limit: 40
      });

      const recent = rows.filter((item) => {
        if (typeof item.startTime !== 'string') {
          return false;
        }
        const ts = Date.parse(item.startTime);
        return Number.isFinite(ts) && ts >= startedAtMs - 4_000;
      });

      const archiveRows = recent.filter((item) => {
        if (typeof item.filename !== 'string') {
          return false;
        }

        return (
          item.filename.includes(sid + '.webblackbox') ||
          item.filename.endsWith('.webblackbox') ||
          item.filename.endsWith('.zip') ||
          item.mime === 'application/zip'
        );
      });
      const match =
        archiveRows.find((item) => item.filename.includes(sid + '.webblackbox')) ??
        archiveRows.find((item) => item.filename.endsWith('.webblackbox')) ??
        archiveRows.find((item) => item.filename.endsWith('.zip')) ??
        archiveRows[0] ??
        null;

      const latest = match ?? null;
      const latestRecent = recent[0] ?? null;

      return {
        complete:
          latest && latest.state === 'complete' && typeof latest.filename === 'string'
            ? {
                id: latest.id,
                filename: latest.filename,
                state: latest.state,
                bytesReceived: latest.bytesReceived,
                totalBytes: latest.totalBytes,
                mime: latest.mime,
                url: latest.url
              }
            : null,
        latest: latest
          ? {
              id: latest.id,
              filename: latest.filename,
              state: latest.state,
              error: latest.error,
              bytesReceived: latest.bytesReceived,
              totalBytes: latest.totalBytes,
              mime: latest.mime,
              url: latest.url
            }
          : null,
        latestRecent: latestRecent
          ? {
              id: latestRecent.id,
              filename: latestRecent.filename,
              state: latestRecent.state,
              error: latestRecent.error,
              bytesReceived: latestRecent.bytesReceived,
              totalBytes: latestRecent.totalBytes,
              mime: latestRecent.mime,
              url: latestRecent.url
            }
          : null
      };
    })()
  `;

  return waitFor(
    async () => {
      const snapshot = await popupClient.evaluate(expression);

      if (!snapshot) {
        return null;
      }

      if (snapshot.complete) {
        return snapshot.complete;
      }

      const latest = snapshot.latest;

      if (latest && latest.state && latest.state !== "in_progress") {
        const suffix = latest.error ? ` (${latest.error})` : "";
        throw new Error(`Download ended in state '${latest.state}'${suffix}`);
      }

      return null;
    },
    timeoutMs,
    400,
    "Download not completed"
  );
}

async function waitForExportedArchiveFile(sid, startedAtMs, timeoutMs) {
  return waitFor(
    async () => {
      const directories = [resolve(downloadDir, "webblackbox"), downloadDir];
      const matches = [];

      for (const directory of directories) {
        let entries;

        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const entry of entries) {
          const isArchive = entry.name.endsWith(".webblackbox") || entry.name.endsWith(".zip");

          if (!entry.isFile() || !isArchive) {
            continue;
          }

          const filename = resolve(directory, entry.name);
          const info = await stat(filename).catch(() => null);

          if (!info || info.size <= 0 || info.mtimeMs < startedAtMs - 5_000) {
            continue;
          }

          matches.push({
            filename,
            state: "complete",
            bytesReceived: info.size,
            totalBytes: info.size,
            url: null,
            mtimeMs: info.mtimeMs,
            sidMatch: entry.name.includes(sid)
          });
        }
      }

      matches.sort(
        (left, right) =>
          Number(right.sidMatch) - Number(left.sidMatch) || right.mtimeMs - left.mtimeMs
      );
      return matches[0] ?? null;
    },
    timeoutMs,
    400,
    "Exported archive file not found"
  );
}

async function runRealisticScenario(demoClient, durationMs) {
  return demoClient.evaluate(
    `
      (async () => {
        if (!window.__realistic || typeof window.__realistic.run !== 'function') {
          return { ok: false, reason: 'realistic-site-script-missing' };
        }

        return window.__realistic.run(${JSON.stringify(durationMs)});
      })()
    `,
    { timeoutMs: durationMs + 60_000 }
  );
}

/** Every burst, poll and XHR request the realistic page reports is in the waterfall. */
function checkRealisticTraffic(archive, scenario) {
  const urls = archive.getNetworkWaterfall().map((entry) => entry.url);
  const recorded = urls.filter((url) => /\/api\/(items|text|slow|poll)\b/.test(url)).length;
  const sent = Number(scenario?.fetches ?? 0) + Number(scenario?.xhrs ?? 0);

  return { ok: sent > 0 && recorded >= sent, sent, recorded };
}

/** The POST that sent Content-Type twice ("application/json, application/json") kept its body. */
function checkDuplicatedContentTypeBody(archive) {
  const entry = archive
    .getNetworkWaterfall()
    .find((candidate) => candidate.url.includes("/api/echo/json-twice"));

  return {
    ok: typeof entry?.requestBodyText === "string" && entry.requestBodyText.length > 0,
    found: Boolean(entry),
    contentType: entry?.requestHeaders["content-type"],
    skipReason: entry?.requestBodySkipReason
  };
}

/**
 * What the realistic site must leave in a Full-capture archive. Bodies: none lost silently, the
 * 2.6 MB bundle recorded as too large, no reads lost to load, SVG kept as text, `data:` URLs not
 * counted. Requests the server held from page load: started before the capture (recorded as
 * such), or, when Start reloads the page, inside it with their bodies. Traffic: at least what the
 * page reports it sent, every WebSocket frame whole, perf and console signals present.
 */
function realisticCompletenessExpectations(scenario, { reloadAfterStart = false } = {}) {
  const frames = Number(scenario?.wsSent ?? 0) + Number(scenario?.wsReceived ?? 0);
  const held = Number(scenario?.heldRequests ?? 0);

  return {
    maxMissingResponseBodies: 0,
    maxMissingRequestBodies: 0,
    maxInternalRequests: 0,
    minRequests: 300,
    minResponseBodies: 250,
    // string, JSON, JSON with Content-Type sent twice, untyped Blob, typed Blob, ArrayBuffer,
    // URLSearchParams, PUT, XHR, beacon.
    minRequestBodies: 10,
    minSkipReasons: {
      "too-large": 1,
      "started-before-capture": reloadAfterStart ? 0 : held
    },
    maxSkipReasons: {
      backlog: 0,
      "session-limit": 0,
      "not-retained": 0,
      "fetch-failed": 0,
      "mime-not-allowed": 0,
      "started-before-capture": reloadAfterStart ? 0 : held
    },
    minSvgBodies: Number(scenario?.svgLoads ?? 0) + (reloadAfterStart ? 1 : 0),
    minDataUrls: Number(scenario?.dataUrls ?? 0) > 0 ? 1 : 0,
    // The last frames can race the socket close at stop.
    minWsFrames: Math.max(1, frames - 2),
    maxCutWsFrames: 0,
    minConsoleEntries: 3,
    minWithStack: 1,
    minVitals: 1
  };
}

async function runDemoScenario(demoClient) {
  const expression = `
    (async () => {
      if (!window.__wbDemo || typeof window.__wbDemo.runScenario !== 'function') {
        return { ok: false, reason: 'demo-scenario-missing' };
      }

      try {
        return await window.__wbDemo.runScenario({ taskTitle: 'Fullchain E2E Task' });
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error)
        };
      }
    })()
  `;

  return demoClient.evaluate(expression);
}

async function runRealWorldScenarioAddons({
  scenario,
  demoClient,
  control,
  baseUrl,
  demoUrl,
  browserClient
}) {
  if (!scenario) {
    return { ok: true, skipped: true };
  }

  const wantsIframeNetwork = scenario.includes("iframe") || scenario.includes("multitarget");
  const wantsChildTarget = scenario.includes("multitarget");
  const wantsMultiTab = scenario.includes("multitab");
  const pageResult = await demoClient.evaluate(`
    (async () => {
      const result = {
        ok: true,
        scenario: ${JSON.stringify(scenario)},
        spaRoutes: [],
        markers: [],
        iframe: false,
        iframeNetworkBytes: 0,
        worker: false,
        workerNetworkBytes: 0,
        upload: false,
        download: false,
        largeResponseBytes: 0,
        longRecordingMs: 0,
        permissionDenied: false
      };
      const mark = (message) => {
        const marker = '[wb-realworld] ' + message;
        result.markers.push(marker);
        console.info(marker);
        return marker;
      };

      try {
        history.pushState({ route: 'settings' }, '', '#/settings');
        window.dispatchEvent(new PopStateEvent('popstate', { state: { route: 'settings' } }));
        result.spaRoutes.push(location.href);
        history.replaceState({ route: 'checkout' }, '', '#/checkout?step=payment');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
        result.spaRoutes.push(location.href);
        mark('spa route checkout');

        const iframe = document.createElement('iframe');
        iframe.id = 'wb-realworld-frame';
        iframe.srcdoc = '<!doctype html><button id="frame-button">Frame action</button><script>document.body.dataset.ready="true";<\\/script>';
        document.body.appendChild(iframe);
        await new Promise((resolve) => setTimeout(resolve, 150));
        iframe.contentDocument?.getElementById('frame-button')?.dispatchEvent(
          new MouseEvent('click', { bubbles: true })
        );
        result.iframe = iframe.contentDocument?.body?.dataset.ready === 'true';

        // A same-origin page frame runs its own content script, which connects its own port
        // while the page records: the page's capture must go on (its markers below must land).
        const pageFrame = document.createElement('iframe');
        pageFrame.id = 'wb-realworld-page-frame';
        pageFrame.src = '/demo/frame.html';
        const pageFrameLoaded = new Promise((resolve) =>
          pageFrame.addEventListener('load', resolve, { once: true })
        );
        document.body.appendChild(pageFrame);
        await pageFrameLoaded;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        result.pageFrame = pageFrame.contentDocument?.body?.dataset.ready === 'true';
        mark('iframe ready');

        if (${JSON.stringify(wantsIframeNetwork)}) {
          const iframeResponse = await iframe.contentWindow?.fetch('/api/large-response/iframe?bytes=2048');
          const iframeText = iframeResponse ? await iframeResponse.text() : '';
          result.iframeNetworkBytes = iframeText.length;
          mark('iframe network ' + result.iframeNetworkBytes);
        }

        if (${JSON.stringify(wantsChildTarget)}) {
          const workerResult = await new Promise((resolve) => {
            const workerFetchUrl = new URL('/api/large-response/worker?bytes=2048', location.href).href;
            const workerSource = [
              'self.onmessage = async () => {',
              '  try {',
              '    const response = await fetch(' + JSON.stringify(workerFetchUrl) + ');',
              '    const text = await response.text();',
              '    self.postMessage({ ok: true, bytes: text.length });',
              '  } catch (error) {',
              '    self.postMessage({',
              '      ok: false,',
              '      reason: error instanceof Error ? error.message : String(error)',
              '    });',
              '  }',
              '};'
            ].join('\\n');
            const blobUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
            const worker = new Worker(blobUrl);
            const timeout = setTimeout(() => {
              worker.terminate();
              URL.revokeObjectURL(blobUrl);
              resolve({ ok: false, reason: 'worker-timeout' });
            }, 5000);
            worker.onmessage = (event) => {
              clearTimeout(timeout);
              worker.terminate();
              URL.revokeObjectURL(blobUrl);
              resolve(event.data);
            };
            worker.onerror = (event) => {
              clearTimeout(timeout);
              worker.terminate();
              URL.revokeObjectURL(blobUrl);
              resolve({ ok: false, reason: event.message || 'worker-error' });
            };
            worker.postMessage({ start: true });
          });
          result.worker = workerResult?.ok === true;
          result.workerNetworkBytes = Number(workerResult?.bytes ?? 0);
          if (!result.worker) {
            result.workerReason = workerResult?.reason ?? 'worker-failed';
          }
          mark('worker target network ' + result.workerNetworkBytes);
        }

        const input = document.createElement('input');
        input.type = 'file';
        input.id = 'wb-realworld-upload';
        document.body.appendChild(input);
        input.dispatchEvent(new Event('change', { bubbles: true }));
        result.upload = true;
        mark('upload change');

        const link = document.createElement('a');
        link.download = 'webblackbox-realworld-download.txt';
        link.href = URL.createObjectURL(new Blob(['download-body'], { type: 'text/plain' }));
        document.body.appendChild(link);
        link.click();
        result.download = true;
        mark('download click');

        const response = await fetch('/api/large-response?bytes=${Math.floor(realWorldLargeResponseBytes)}');
        const text = await response.text();
        result.largeResponseBytes = text.length;
        mark('large response ' + result.largeResponseBytes);

        document.body.dataset.realWorldTick = String(performance.now());
        mark('long recording page ready');

        return result;
      } catch (error) {
        return {
          ...result,
          ok: false,
          reason: error instanceof Error ? error.message : String(error)
        };
      }
    })()
  `);

  const pointerResult = await performRealWorldPointerActivity(
    demoClient,
    Math.max(500, Math.floor(realWorldLongRecordingMs))
  );
  if (pageResult && typeof pageResult === "object") {
    pageResult.longRecordingMs = pointerResult.durationMs;
    pageResult.pointerMoves = pointerResult.moves;
  }
  const pointerMarker = await emitPageRealWorldMarker(
    demoClient,
    `trusted pointer moves ${pointerResult.moves}`
  );

  const permissionResult = await evaluateControl(
    control,
    `
    (async () => {
      try {
        const chromeApi = typeof chrome === 'object' && chrome !== null ? chrome : null;

        if (!chromeApi?.permissions?.request) {
          return { ok: true, denied: false, granted: false, unavailable: true, reason: 'permissions-api-unavailable' };
        }

        const granted = await new Promise((resolve) => {
          chromeApi.permissions.request({ permissions: ['bookmarks'] }, (value) => {
            resolve(Boolean(value));
          });
        });
        const lastError = chromeApi.runtime.lastError?.message ?? null;
        return { ok: true, denied: !granted, granted, lastError };
      } catch (error) {
        return {
          ok: true,
          denied: true,
          reason: error instanceof Error ? error.message : String(error)
        };
      }
    })()
  `
  );

  const permissionMarker = await emitPageRealWorldMarker(
    demoClient,
    permissionResult?.granted
      ? "permission unexpectedly granted"
      : permissionResult?.unavailable
        ? "permission unavailable"
        : "permission denied"
  );

  let multiTabResult = { ok: true, skipped: true };
  let multiTabMarker = null;
  if (wantsMultiTab) {
    const target = await openTarget(baseUrl, `${demoUrl}?realworld-secondary=1`);
    state.openedTargetIds.push(target.id);
    let secondaryClient = null;

    try {
      secondaryClient = new CdpClient(target.webSocketDebuggerUrl, cdpClientOptions);
      await secondaryClient.connect();
      await secondaryClient.send("Runtime.enable");
      await waitFor(
        async () => {
          const loaded = await secondaryClient.evaluate(`
            (() => ({
              href: location.href,
              readyState: document.readyState
            }))()
          `);

          return loaded?.href?.includes("realworld-secondary=1") && loaded?.readyState !== "loading"
            ? loaded
            : null;
        },
        5_000,
        100,
        "Secondary target did not finish loading"
      );
      const secondaryMarker = await emitPageRealWorldMarker(
        secondaryClient,
        "secondary target exercised"
      );

      multiTabResult = {
        ok: Boolean(target.id && secondaryMarker),
        targetId: target.id,
        url: target.url ?? null,
        secondaryMarker
      };
    } catch (error) {
      multiTabResult = {
        ok: false,
        targetId: target.id,
        url: target.url ?? null,
        reason: error instanceof Error ? error.message : String(error)
      };
    } finally {
      if (secondaryClient) {
        secondaryClient.close();
      }
    }

    await closeTarget(baseUrl, target.id);
    state.openedTargetIds = state.openedTargetIds.filter((id) => id !== target.id);
    if (multiTabResult.ok) {
      multiTabMarker = await emitPageRealWorldMarker(demoClient, "primary tab survived multitab");
    }
  }

  const expectedMarkers = [
    ...(Array.isArray(pageResult?.markers) ? pageResult.markers : []),
    pointerMarker,
    permissionMarker,
    multiTabMarker
  ].filter((marker) => typeof marker === "string" && marker.length > 0);
  // Recorded URLs keep the path but not the query string.
  const expectedUrls = ["/api/large-response"];
  if (wantsIframeNetwork) {
    expectedUrls.push("/api/large-response/iframe");
  }
  if (wantsChildTarget) {
    expectedUrls.push("/api/large-response/worker");
  }

  return {
    ok:
      pageResult?.ok === true &&
      pageResult.iframe === true &&
      pageResult.pageFrame === true &&
      (!wantsIframeNetwork || pageResult.iframeNetworkBytes >= 1024) &&
      (!wantsChildTarget ||
        (pageResult.worker === true && pageResult.workerNetworkBytes >= 1024)) &&
      pageResult.upload === true &&
      pageResult.download === true &&
      pageResult.largeResponseBytes >= 1024 &&
      pointerResult.ok === true &&
      pointerResult.durationMs >= 500 &&
      permissionResult?.ok === true &&
      permissionResult?.granted !== true &&
      multiTabResult.ok === true,
    page: pageResult,
    pointer: pointerResult,
    permission: permissionResult,
    multiTab: multiTabResult,
    archiveEvidence: {
      markers: expectedMarkers,
      urls: expectedUrls,
      eventTypes: ["console.entry", "network.request"]
    },
    browserConnected: Boolean(browserClient)
  };
}

async function performRealWorldPointerActivity(demoClient, durationMs) {
  const started = Date.now();
  let moves = 0;

  while (Date.now() - started < durationMs) {
    await demoClient.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 24 + (moves % 32),
      y: 24 + ((moves * 3) % 32),
      button: "none"
    });
    moves += 1;
    await sleep(125);
  }

  return {
    ok: moves > 0,
    moves,
    durationMs: Date.now() - started
  };
}

async function emitPageRealWorldMarker(demoClient, message) {
  return demoClient.evaluate(`
    (() => {
      const marker = ${JSON.stringify("[wb-realworld] ")} + ${JSON.stringify(message)};
      console.info(marker);
      return marker;
    })()
  `);
}

async function requestFinalE2eMarkerCapture(demoClient, mode) {
  return demoClient.evaluate(`
    (() => {
      const message = '[wb-e2e] final ' + ${JSON.stringify(mode)} + ' marker';

      window.postMessage(
        {
          source: 'webblackbox-injected',
          kind: 'marker',
          message
        },
        '*'
      );
      console.info(message);

      return { ok: true, message };
    })()
  `);
}

async function verifyExtensionRestart(control, urlBase, extensionId) {
  let reload = await evaluateControl(
    control,
    `
      (() => {
        const chromeApi = typeof chrome === 'object' && chrome !== null ? chrome : null;

        if (typeof chromeApi?.runtime?.reload !== 'function') {
          return { ok: false, reason: 'runtime-reload-unavailable' };
        }

        chromeApi.runtime.reload();
        return { ok: true, via: ${JSON.stringify(control.kind)} };
      })()
    `
  ).catch((error) => ({
    ok: false,
    reason: error instanceof Error ? error.message : String(error)
  }));

  if (!reload.ok && control.kind !== "popup") {
    const swTarget = await waitForExtensionServiceWorker(urlBase, 10_000, extensionId).catch(
      () => null
    );

    if (swTarget?.webSocketDebuggerUrl) {
      const swClient = new CdpClient(swTarget.webSocketDebuggerUrl, cdpClientOptions);

      try {
        await swClient.connect();
        await swClient.send("Runtime.enable");
        reload = await swClient
          .evaluate(
            `
              (() => {
                const chromeApi = typeof chrome === 'object' && chrome !== null ? chrome : null;

                if (typeof chromeApi?.runtime?.reload !== 'function') {
                  return { ok: false, reason: 'service-worker-runtime-reload-unavailable' };
                }

                chromeApi.runtime.reload();
                return { ok: true, via: 'service-worker' };
              })()
            `
          )
          .catch((error) => ({
            ok: false,
            reason: error instanceof Error ? error.message : String(error)
          }));
      } finally {
        swClient.close();
      }
    }
  }

  if (!reload.ok) {
    return reload;
  }

  const swTarget = await waitForExtensionServiceWorker(urlBase, 20_000, extensionId);
  return {
    ok: Boolean(swTarget?.id),
    targetId: swTarget?.id ?? null,
    url: swTarget?.url ?? null
  };
}

async function waitForPopupUiReady(popupClient, timeoutMs) {
  return waitFor(
    async () => {
      const snapshot = await popupClient.evaluate(`
        (() => {
          const start = document.querySelector("[data-action='start']");
          const hasChromeRuntime =
            typeof chrome === "object" &&
            chrome !== null &&
            typeof chrome.runtime === "object" &&
            chrome.runtime !== null &&
            typeof chrome.runtime.id === "string";

          return {
            ready: Boolean(start && hasChromeRuntime),
            hasStart: Boolean(start),
            hasChromeRuntime
          };
        })()
      `);

      if (snapshot?.ready) {
        return snapshot;
      }

      return null;
    },
    timeoutMs,
    200,
    "Popup UI not ready"
  );
}

async function waitForPopupRuntimeReady(popupClient, timeoutMs) {
  let lastSnapshot = null;

  try {
    return await waitFor(
      async () => {
        const snapshot = await popupClient.evaluate(`
          (() => {
            const hasRuntimeMessaging =
              typeof chrome === "object" &&
              chrome !== null &&
              typeof chrome.runtime === "object" &&
              chrome.runtime !== null &&
              typeof chrome.runtime.id === "string" &&
              typeof chrome.runtime.sendMessage === "function";
            const hasTabsQuery =
              typeof chrome === "object" &&
              chrome !== null &&
              typeof chrome.tabs === "object" &&
              chrome.tabs !== null &&
              typeof chrome.tabs.query === "function";

            return {
              url: location.href,
              title: document.title,
              bodyText: (document.body?.textContent ?? "").trim().slice(0, 240),
              readyState: document.readyState,
              hasChrome: typeof chrome === "object" && chrome !== null,
              runtimeId:
                typeof chrome === "object" &&
                chrome !== null &&
                typeof chrome.runtime === "object" &&
                chrome.runtime !== null &&
                typeof chrome.runtime.id === "string"
                  ? chrome.runtime.id
                  : null,
              hasRuntimeMessaging,
              hasTabsQuery
            };
          })()
        `);

        lastSnapshot = snapshot ?? null;

        if (snapshot?.hasRuntimeMessaging) {
          return snapshot;
        }

        return null;
      },
      timeoutMs,
      200,
      "Popup runtime not ready"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}; lastSnapshot=${JSON.stringify(lastSnapshot)}`);
  }
}

async function waitForPlayerReady(playerClient, timeoutMs) {
  return waitFor(
    async () => {
      const ready = await playerClient.evaluate(
        `Boolean(document.querySelector(${JSON.stringify(PLAYER_READY_SELECTOR)}))`
      );

      return ready ? true : null;
    },
    timeoutMs,
    250,
    "Player UI not ready"
  );
}

async function waitForFile(path, timeoutMs) {
  return waitFor(
    async () => {
      try {
        return await stat(path);
      } catch {
        return null;
      }
    },
    timeoutMs,
    250,
    `File not found: ${path}`
  );
}

async function rebuildArchiveFromDataUrl(dataUrl, outputPath) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    return false;
  }

  const marker = "base64,";
  const markerIndex = dataUrl.indexOf(marker);

  if (markerIndex === -1) {
    return false;
  }

  const base64 = dataUrl.slice(markerIndex + marker.length);

  if (base64.length === 0) {
    return false;
  }

  const bytes = Buffer.from(base64, "base64");

  if (bytes.byteLength === 0) {
    return false;
  }

  await writeFile(outputPath, bytes);
  return true;
}

async function cleanup() {
  if (state.realisticSite) {
    await state.realisticSite.close().catch(() => undefined);
    state.realisticSite = null;
  }

  if (state.browserClient) {
    state.browserClient.close();
    state.browserClient = null;
  }

  if (state.playerClient) {
    state.playerClient.close();
    state.playerClient = null;
  }

  if (state.demoClient) {
    state.demoClient.close();
    state.demoClient = null;
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
    if (state.baseUrl) {
      await closeTarget(state.baseUrl, targetId);
    }
  }

  const chromeProcess = state.chromeProcess;
  await terminateChromeProcess(chromeProcess);

  state.chromeProcess = null;
  state.baseUrl = null;

  if (state.logStream) {
    // Chrome's helper processes can outlive it and keep writing to the shared pipes.
    chromeProcess?.stdout?.unpipe(state.logStream);
    chromeProcess?.stderr?.unpipe(state.logStream);
    await new Promise((resolve) => {
      state.logStream.end(resolve);
    });
    state.logStream = null;
  }

  state.fidelitySockets?.closeAll();
  state.fidelitySockets = null;

  if (state.server) {
    await new Promise((resolve) => {
      state.server.close(() => resolve());
    });
    state.server = null;
  }

  if (state.tempExtensionDir) {
    await rm(state.tempExtensionDir, { recursive: true, force: true }).catch(() => undefined);
    state.tempExtensionDir = null;
  }
}
