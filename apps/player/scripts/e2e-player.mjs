#!/usr/bin/env node
// E2E for the Player. Runs the shell scenarios (scripts/e2e-next/shell.mjs), then every
// feature's scenarios (src/next/features/<feature>/<feature>.e2e.mjs), then proves the CSP guard
// is live. Every page runs under the Player CSP (no `style-src 'unsafe-inline'`): any CSP
// violation, uncaught exception or forbidden construct in the build fails the run. Selectors are
// `data-testid` only.
//
// Env: WB_E2E_CHROME_BIN, WB_E2E_HEADLESS (default 1), WB_E2E_PLAYER_DIR (default ./build),
// WB_E2E_PLAYER_FEATURES ("feed,network": only these feature scenarios),
// WB_E2E_SCREENSHOTS_DIR (capture the player at 1440/1920, light/dark, EN/RU),
// WB_E2E_REAL_ARCHIVE + WB_E2E_REAL_PASSPHRASE (also open a real archive; screenshots stay local).
import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { captureScreenshots, verifyRealArchive } from "./e2e-next/capture.mjs";
import {
  verifyDialogsAndHints,
  verifyEmptyState,
  verifyEncryptedOpen,
  verifyHashRestore,
  verifyKeyboard,
  verifyLiveLocaleSwitch,
  verifyLoadedLayout,
  verifyNarrowLayout,
  verifyPhysicalKeys,
  verifyScrubbing,
  verifySplitters,
  verifyTheme
} from "./e2e-next/shell.mjs";
import {
  CdpClient,
  CHROME_CANDIDATES,
  closeTarget,
  launchChromeWithRetry,
  openTarget,
  resolveChromeBinary,
  sleep,
  startPlayerServer,
  terminateChromeProcess,
  waitFor
} from "./lib/cdp-harness.mjs";
import { createEncryptedArchive } from "./lib/encrypted-archive.mjs";
import {
  assert,
  createScenarioContext,
  findFeatureScenarioFiles,
  loadFeatureScenarios,
  openSyntheticArchive,
  setViewport,
  verifyBuildOutput
} from "./lib/next-e2e.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const playerDir = process.env.WB_E2E_PLAYER_DIR ?? resolve(root, "..", "build");
const featuresDir = resolve(root, "..", "src", "next", "features");
const headless = (process.env.WB_E2E_HEADLESS ?? "1") !== "0";
const stamp = Date.now();
const artifactsDir = process.env.WB_E2E_ARTIFACTS_DIR ?? `/tmp/webblackbox-player-${stamp}`;
const screenshotsDir = process.env.WB_E2E_SCREENSHOTS_DIR ?? null;
const realArchive = process.env.WB_E2E_REAL_ARCHIVE ?? null;
const realPassphrase = process.env.WB_E2E_REAL_PASSPHRASE ?? "";
const onlyFeatures = process.env.WB_E2E_PLAYER_FEATURES ?? null;

const state = { chrome: null, client: null, targetId: null, baseUrl: null, server: null };

main().catch(async (error) => {
  console.error("Player E2E failed:", error instanceof Error ? error.message : String(error));
  await cleanup();
  process.exit(1);
});

async function main() {
  await access(resolve(playerDir, "main.js"), constants.R_OK);
  const build = await verifyBuildOutput(playerDir);
  const suites = await loadFeatureScenarios(
    await findFeatureScenarioFiles(featuresDir),
    onlyFeatures
  );
  await mkdir(artifactsDir, { recursive: true });

  const archivePath = resolve(artifactsDir, "synthetic-replay.webblackbox");
  await writeFile(archivePath, await createEncryptedArchive());

  const server = await startPlayerServer(playerDir);
  state.server = server.server;
  const origin = `http://127.0.0.1:${server.port}`;
  const chrome = await launchChromeWithRetry(await resolveChromeBinary(CHROME_CANDIDATES), {
    profileDir: `/tmp/webblackbox-player-profile-${stamp}`,
    requestedRemotePort: null,
    headless,
    logPath: `/tmp/webblackbox-player-${stamp}.log`,
    attempts: 2,
    readyTimeoutMs: 25_000
  });
  state.chrome = chrome;
  state.baseUrl = chrome.baseUrl;

  const target = await openTarget(chrome.baseUrl, "about:blank");
  state.targetId = target.id;
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  state.client = client;

  const exceptions = [];
  client.on("Runtime.exceptionThrown", (params) => {
    exceptions.push(
      params?.exceptionDetails?.exception?.description ?? params?.exceptionDetails?.text
    );
  });
  // Violations reach Node through a binding, so pages replaced by later navigations count too.
  const cspViolations = [];
  client.on("Runtime.bindingCalled", (params) => {
    if (params?.name === "__wbCspViolation") {
      cspViolations.push(JSON.parse(params.payload));
    }
  });
  await client.send("Runtime.enable");
  await client.send("Runtime.addBinding", { name: "__wbCspViolation" });
  await client.send("DOM.enable");
  await client.send("Page.enable");
  await client.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `document.addEventListener("securitypolicyviolation", (e) => window.__wbCspViolation(JSON.stringify({ page: location.href, violation: [e.violatedDirective, e.blockedURI, e.sourceFile + ":" + e.lineNumber + ":" + e.columnNumber, e.sample].join(" ") })));
             window.__unloads = 0; window.addEventListener("beforeunload", () => { window.__unloads += 1; });`
  });
  await setViewport(client, 1440, 900);
  await client.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }]
  });

  const results = { build };
  results.empty = await verifyEmptyState(client, `${origin}/?lang=en`);
  assert(
    await client.evaluate("typeof window.__wbCspViolation === 'function'"),
    "CSP violation binding is missing; the CSP check would pass vacuously"
  );
  results.open = await verifyEncryptedOpen(client, archivePath);
  results.layout = await verifyLoadedLayout(client);
  results.keyboard = await verifyKeyboard(client);
  results.physicalKeys = await verifyPhysicalKeys(client);
  results.scrub = await verifyScrubbing(client);
  results.locale = await verifyLiveLocaleSwitch(client);
  results.theme = await verifyTheme(client);
  results.dialogs = await verifyDialogsAndHints(client);
  results.hash = await verifyHashRestore(client, origin, archivePath);
  results.splitters = await verifySplitters(client, { origin, archivePath });
  results.responsive = await verifyNarrowLayout(client);
  results.features = await runFeatureScenarios(suites, { client, origin, archivePath });
  results.cspGuard = await verifyCspGuard(client, { origin, archivePath }, cspViolations);

  if (screenshotsDir) {
    results.screenshots = await captureScreenshots(client, origin, archivePath, screenshotsDir);
  }

  if (realArchive) {
    results.real = await verifyRealArchive(
      client,
      origin,
      realArchive,
      realPassphrase,
      artifactsDir
    );
  }

  // Every page counts; the guard's deliberate probe was taken out of the list.
  results.csp = cspViolations;
  assert(results.csp.length === 0, "CSP violations in the player", results.csp);

  assert(exceptions.length === 0, "Runtime exceptions in the player page", exceptions);
  console.log("Player E2E passed:", JSON.stringify(results, null, 2));
  await cleanup();
}

/** Each feature's scenarios on a 1440×900 light page, in feature-name order. */
async function runFeatureScenarios(suites, { client, origin, archivePath }) {
  const context = createScenarioContext({ client, origin, archivePath, artifactsDir });
  const results = {};

  for (const suite of suites) {
    for (const scenario of suite.scenarios) {
      const name = `${suite.feature}: ${scenario.name}`;
      await setViewport(client, 1440, 900);

      try {
        results[name] = (await scenario.run(context)) ?? true;
      } catch (error) {
        throw new Error(`[${name}] ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return results;
}

/**
 * The Player CSP has no `style-src 'unsafe-inline'`, and the violation listener is live: an
 * injected probe <style> must be reported (so "no violations" cannot pass vacuously). The probe's
 * report is removed from `violations` before the final check.
 */
async function verifyCspGuard(client, { origin, archivePath }, violations) {
  await setViewport(client, 1440, 900);
  await openSyntheticArchive(client, { origin, archivePath });
  const policy = await client.evaluate(
    `document.querySelector('meta[http-equiv="Content-Security-Policy"]').content`
  );
  const styleSources = /style-src ([^;]*)/.exec(policy)?.[1] ?? "";
  assert(
    styleSources.trim() === "'self'" && !policy.includes("'unsafe-inline'"),
    "The Player CSP still allows inline styles or scripts",
    policy
  );

  const before = violations.length;
  await client.evaluate(
    `document.head.append(Object.assign(document.createElement("style"), { textContent: ".wb-csp-probe{}" }))`
  );
  await waitFor(
    async () => (violations.length > before ? true : null),
    5_000,
    100,
    "An injected <style> was not reported: the CSP guard is not live"
  );
  await sleep(200);
  const probe = violations.splice(before);
  assert(
    probe.every((entry) => entry.violation.startsWith("style-src")),
    "The probe reported something other than a style violation",
    probe
  );
  return { policy, violationsBeforeProbe: before, probeReported: probe.length };
}

async function cleanup() {
  state.client?.close();
  state.client = null;

  if (state.targetId && state.baseUrl) {
    await closeTarget(state.baseUrl, state.targetId);
  }

  if (state.chrome) {
    await terminateChromeProcess(state.chrome.proc);
    await new Promise((resolvePromise) => state.chrome.logStream.end(resolvePromise));
    state.chrome = null;
  }

  if (state.server) {
    await new Promise((resolvePromise) => state.server.close(() => resolvePromise()));
    state.server = null;
  }
}
