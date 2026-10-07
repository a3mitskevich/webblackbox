#!/usr/bin/env node

// E2E: the one-time move of v1 `webblackbox.options` into the profiles store. A v1 record as the
// options page saved it (sampling, freeze-on-error, redaction, site body policies, performance
// budget) is written with no profiles store, as an older version left it. After a browser restart
// the service worker's start migrates it: the Default profile carries the v1 values, the budget has
// its own key, the settings are marked current and v1 options are gone. Start picks the Default
// profile and keeps a Lite start in Lite, as v1 options did.

import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, createProfileE2eHarness, waitFor } from "./lib/profile-e2e-harness.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(root, "..");
const harness = createProfileE2eHarness({
  name: "settings-migration",
  appRoot,
  defaultPort: "9240"
});

const LEGACY_OPTIONS_KEY = "webblackbox.options";
const PROFILES_KEY = "webblackbox.profiles";
const BUDGET_KEY = "webblackbox.performanceBudget";
const SETTINGS_VERSION_KEY = "webblackbox.settingsVersion";

const PERFORMANCE_BUDGET = {
  lcpWarnMs: 4000,
  requestWarnMs: 900,
  errorRateWarnPct: 20,
  autoFreezeOnBreach: true
};
const SITE_POLICIES = [
  {
    originPattern: "https://*.example.test",
    mode: "full",
    enabled: true,
    allowBodyCapture: true,
    bodyMimeAllowlist: ["application/json"],
    pathAllowlist: ["/api/*"],
    pathDenylist: []
  }
];
/** A v1 record as the options page saved it (the whole normalized config plus the budget). */
const V1_OPTIONS = {
  optionsVersion: 1,
  mode: "lite",
  ringBufferMinutes: 10,
  freezeOnError: false,
  freezeOnNetworkFailure: true,
  freezeOnLongTaskSpike: true,
  sampling: {
    mousemoveHz: 33,
    scrollHz: 9,
    domFlushMs: 150,
    screenshotIdleMs: 0,
    snapshotIntervalMs: 20000,
    actionWindowMs: 1500,
    bodyCaptureMaxBytes: 0
  },
  redaction: {
    redactHeaders: ["authorization", "cookie", "set-cookie"],
    redactCookieNames: ["token", "session"],
    redactBodyPatterns: ["password", "pin"],
    blockedSelectors: [".pii", "[data-secret]"],
    hashSensitiveValues: true
  },
  sitePolicies: SITE_POLICIES,
  performanceBudget: PERFORMANCE_BUDGET
};

main().catch(async (error) => {
  console.error(
    "Settings migration E2E failed:",
    error instanceof Error ? error.message : String(error)
  );
  await harness.cleanup();
  process.exit(1);
});

async function main() {
  const pageUrl = await startPageServer();
  const first = await harness.launch(pageUrl);

  // An older version's storage: v1 options, no profiles store, no settings version.
  await first.popup.evaluate(`
    chrome.storage.local
      .remove(${JSON.stringify([PROFILES_KEY, BUDGET_KEY, SETTINGS_VERSION_KEY])})
      .then(() => chrome.storage.local.set({ ${JSON.stringify(LEGACY_OPTIONS_KEY)}: ${JSON.stringify(V1_OPTIONS)} }))
      .then(() => true)
  `);

  await harness.stopBrowser();
  const { popup, swExceptions } = await harness.launch(pageUrl, { keepProfile: true });
  const stored = await waitFor(
    () =>
      popup.evaluate(`
        chrome.storage.local.get(null).then((values) =>
          values[${JSON.stringify(SETTINGS_VERSION_KEY)}] === 1 ? values : null
        )
      `),
    15_000,
    "The service worker did not migrate the settings at its start"
  );
  const defaultProfile = stored[PROFILES_KEY]?.profiles?.find(
    (profile) => profile.id === "default"
  );

  assert(stored[LEGACY_OPTIONS_KEY] === undefined, "v1 options are still stored", stored);
  assert(
    sameValue(stored[BUDGET_KEY], PERFORMANCE_BUDGET),
    "The performance budget did not move to its own key",
    { budget: stored[BUDGET_KEY] }
  );
  assert(
    stored[PROFILES_KEY]?.defaultProfileId === "default" && defaultProfile,
    "The profiles store has no Default profile",
    stored[PROFILES_KEY]
  );
  assert(
    sameValue(defaultProfile.sampling, V1_OPTIONS.sampling) &&
      defaultProfile.recorder?.freezeOnError === false &&
      sameValue(defaultProfile.redaction.blockedSelectors, V1_OPTIONS.redaction.blockedSelectors) &&
      sameValue(defaultProfile.sitePolicies, SITE_POLICIES),
    "The Default profile lost v1 values",
    defaultProfile
  );

  const tabId = await popup.evaluate(`
    chrome.tabs.query({}).then((tabs) =>
      tabs.find((tab) => tab.url?.startsWith(${JSON.stringify(pageUrl)}))?.id ?? null
    )
  `);
  assert(typeof tabId === "number", "Page tab not found", { tabId });

  const preview = await popup.evaluate(
    `chrome.runtime.sendMessage({ kind: "ui.resolve-profile", tabId: ${tabId} })`
  );
  assert(
    preview?.selection?.id === "default" &&
      preview.selection.source === "default" &&
      preview.selection.requiresFull === false,
    "Start does not pick the migrated Default profile in either engine",
    preview
  );

  await popup.evaluate(
    `chrome.runtime.sendMessage({ kind: "ui.start", tabId: ${tabId}, mode: "lite" })`
  );
  const session = await waitFor(
    () =>
      popup.evaluate(`
        chrome.runtime
          .sendMessage({ kind: "ui.request-session-list" })
          .then((list) => (list?.sessions ?? []).find((entry) => entry.active) ?? null)
      `),
    20_000,
    "The Lite recording did not start"
  );
  assert(
    session.mode === "lite",
    "A Lite start of the migrated Default did not stay Lite",
    session
  );

  const stopped = await popup.evaluate(
    `chrome.runtime.sendMessage({ kind: "ui.stop", tabId: ${tabId} })`
  );
  assert(stopped?.ok !== false, "Stopping the recording failed", stopped);
  assert(swExceptions.length === 0, "Service worker threw", swExceptions);

  console.log("Settings migration E2E passed.");
  await harness.cleanup();
}

/** Deep equality that ignores object key order (Chrome storage returns keys sorted). */
function sameValue(left, right) {
  return stableJson(left) === stableJson(right);
}

function stableJson(value) {
  return JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry
  );
}

function startPageServer() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><html><head><title>settings migration</title></head>" +
        "<body><h1>WebBlackbox settings migration fixture</h1></body></html>"
    );
  });
  harness.trackServer(server);

  return new Promise((resolveUrl) => {
    server.listen(0, "127.0.0.1", () => {
      resolveUrl(`http://127.0.0.1:${server.address().port}/`);
    });
  });
}
