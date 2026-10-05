#!/usr/bin/env node
// E2E for the React player (`?ui=next`). Runs the shell scenarios (scripts/e2e-next/shell.mjs),
// then every feature's scenarios (src/next/features/<feature>/<feature>.e2e.mjs), then a pass
// under a strict style policy. Any CSP violation, uncaught exception or forbidden construct in
// the build fails the run. Selectors are `data-testid` only.
//
// Env: WB_E2E_CHROME_BIN, WB_E2E_HEADLESS (default 1), WB_E2E_PLAYER_DIR (default ./build),
// WB_E2E_NEXT_FEATURES ("feed,network": only these feature scenarios),
// WB_E2E_SCREENSHOTS_DIR (capture classic vs next at 1440/1920, light/dark, EN/RU),
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
  dragBy,
  enableStrictStyleCsp,
  findFeatureScenarioFiles,
  hover,
  loadFeatureScenarios,
  openSyntheticArchive,
  press,
  setViewport,
  STRICT_CSP_QUERY,
  testId,
  verifyBuildOutput,
  waitForSnapshot
} from "./lib/next-e2e.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const playerDir = process.env.WB_E2E_PLAYER_DIR ?? resolve(root, "..", "build");
const featuresDir = resolve(root, "..", "src", "next", "features");
const headless = (process.env.WB_E2E_HEADLESS ?? "1") !== "0";
const stamp = Date.now();
const artifactsDir = process.env.WB_E2E_ARTIFACTS_DIR ?? `/tmp/webblackbox-player-next-${stamp}`;
const screenshotsDir = process.env.WB_E2E_SCREENSHOTS_DIR ?? null;
const realArchive = process.env.WB_E2E_REAL_ARCHIVE ?? null;
const realPassphrase = process.env.WB_E2E_REAL_PASSPHRASE ?? "";
const onlyFeatures = process.env.WB_E2E_NEXT_FEATURES ?? null;
/** Sample text of the <style> the strict pass injects on purpose to prove the guard is live. */
const CSP_PROBE = "wb-csp-probe";

const state = { chrome: null, client: null, targetId: null, baseUrl: null, server: null };

main().catch(async (error) => {
  console.error("Player next E2E failed:", error instanceof Error ? error.message : String(error));
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
    profileDir: `/tmp/webblackbox-player-next-profile-${stamp}`,
    requestedRemotePort: null,
    headless,
    logPath: `/tmp/webblackbox-player-next-${stamp}.log`,
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
  await enableStrictStyleCsp(client);
  await setViewport(client, 1440, 900);
  await client.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }]
  });

  const results = { build };
  results.empty = await verifyEmptyState(client, `${origin}/?ui=next&lang=en`);
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
  results.strictCsp = await verifyStrictStyleCsp(client, { origin, archivePath }, cspViolations);

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

  // Every page counts, the strict pass included; only the deliberate probe is expected.
  results.csp = cspViolations.filter((entry) => !entry.violation.includes(CSP_PROBE));
  assert(results.csp.length === 0, "CSP violations in the player", results.csp);

  assert(exceptions.length === 0, "Runtime exceptions in the player page", exceptions);
  console.log("Player next E2E passed:", JSON.stringify(results, null, 2));
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
 * The React player under the Player CSP without `style-src 'unsafe-inline'` (R5 drops it): open,
 * play, tooltips, dialogs, tabs, details and the splitter must not need an injected <style>. An
 * injected probe <style> must be reported, so the guard cannot pass vacuously.
 */
async function verifyStrictStyleCsp(client, { origin, archivePath }, violations) {
  await setViewport(client, 1440, 900);
  await openSyntheticArchive(client, { origin, archivePath, query: STRICT_CSP_QUERY });
  const policy = await client.evaluate(
    `document.querySelector('meta[http-equiv="Content-Security-Policy"]').content`
  );
  const styleSources = /style-src ([^;]*)/.exec(policy)?.[1] ?? "";
  assert(
    styleSources.includes("'self'") && !styleSources.includes("'unsafe-inline'"),
    "The strict pass did not get the strict style policy",
    policy
  );

  await client.evaluate("document.activeElement?.blur()");
  await press(client, " ", { code: "Space", keyCode: 32 });
  await sleep(600);
  await press(client, " ", { code: "Space", keyCode: 32 });
  await hover(client, testId("theme-toggle"));
  await waitFor(
    async () =>
      (await client.evaluate(`Boolean(document.querySelector('${testId("tooltip")}'))`))
        ? true
        : null,
    5_000,
    100,
    "No tooltip under the strict policy"
  );
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 600 });
  await press(client, "?", { code: "Slash", shift: true });
  await waitForSnapshot(client, (value) => value.shortcuts, "No shortcut sheet under the policy");
  await press(client, "Escape", { code: "Escape", keyCode: 27 });
  // Keys go to the dialog until its exit transition ends and it unmounts.
  await waitForSnapshot(client, (value) => !value.shortcuts, "The sheet did not close");
  await press(client, "2", { code: "Digit2" });
  await press(client, "1", { code: "Digit1" });
  await press(client, "l");
  await press(client, "Enter", { code: "Enter", keyCode: 13 });
  await waitForSnapshot(client, (value) => value.details !== "", "No details under the policy");
  await dragBy(client, testId("split-body"), -40, 0);
  await press(client, "Escape", { code: "Escape", keyCode: 27 });

  const strictPage = (entry) => entry.page.includes("csp=strict");
  const before = violations.filter(strictPage).length;
  await client.evaluate(
    `document.head.append(Object.assign(document.createElement("style"), { textContent: ".${CSP_PROBE}{}" }))`
  );
  await waitFor(
    async () =>
      violations.filter(strictPage).some((entry) => entry.violation.includes(CSP_PROBE))
        ? true
        : null,
    5_000,
    100,
    "An injected <style> was not reported under the strict policy: the guard is not live"
  );
  return {
    policy,
    violationsBeforeProbe: before,
    probeReported: true
  };
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
