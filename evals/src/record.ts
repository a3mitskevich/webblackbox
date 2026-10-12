#!/usr/bin/env node
// Records every bug zoo scenario with the built extension, once per recording profile, and
// exports encrypted archives into evals/archives/<profile>/<case>.webblackbox (git-ignored).
//
//   pnpm --filter @webblackbox/evals record [--scenario <id|case>]... [--profile <id>]...
//
// Needs `pnpm build` (the unpacked WXT extension in apps/extension/.output/chrome-mv3, or
// WB_E2E_EXTENSION_DIR) and a Chrome binary (WB_E2E_CHROME_BIN).

import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  type CdpClient,
  createProfileE2eHarness,
  sleep,
  waitFor
} from "../../apps/extension/scripts/lib/profile-e2e-harness.mjs";
import {
  type ManifestEntry,
  mergeEntries,
  readManifest,
  writeManifest
} from "./archive-manifest.js";
import { runSteps } from "./browser/steps.js";
import { ARCHIVE_MANIFEST, ARCHIVES_DIR } from "./paths.js";
import { type RecordingProfile, selectProfiles } from "./profiles.js";
import { SCENARIOS, selectScenarios } from "./scenarios/index.js";
import { startBugZooSite } from "./site/server.js";
import type { Scenario } from "./types.js";

const DEFAULT_PASSPHRASE = "webblackbox-bug-zoo-eval";
const MIN_PASSPHRASE_LENGTH = 8;
const DEFAULT_REMOTE_PORT = "9245";
const INDICATOR_TIMEOUT_MS = 25_000;
/** Recording runs a moment before the first step, as a tester's would. */
const AFTER_START_MS = 1_500;
/** Lite page-to-worker latency can exceed 2 s under load: let the last events land. */
const BEFORE_STOP_MS = 4_000;
const AFTER_STOP_MS = 2_000;

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      scenario: { type: "string", multiple: true, default: [] },
      profile: { type: "string", multiple: true, default: [] },
      out: { type: "string", default: ARCHIVES_DIR },
      passphrase: {
        type: "string",
        default: process.env.WB_EVAL_PASSPHRASE ?? DEFAULT_PASSPHRASE
      }
    }
  });
  const scenarios = selectScenarios(values.scenario);
  const profiles = selectProfiles(values.profile);
  const outDir = resolve(values.out);
  const passphrase = values.passphrase;

  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`The passphrase needs at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }

  process.env.WB_E2E_REMOTE_PORT ??= DEFAULT_REMOTE_PORT;
  process.env.WB_E2E_HEADLESS ??= "1";
  await mkdir(outDir, { recursive: true });

  const recorded: ManifestEntry[] = [];

  for (const profile of profiles) {
    for (const scenario of scenarios) {
      const started = Date.now();
      const entry = await recordScenario(scenario, profile, outDir, passphrase);
      recorded.push(entry);
      const outcome = entry.error
        ? `FAILED: ${entry.error}`
        : `${entry.bytes} bytes, symptom ${entry.symptomReproduced ? "reproduced" : "NOT reproduced"}`;
      console.log(
        `[${profile.id}] ${scenario.caseId} ${scenario.id}: ${outcome} (${Date.now() - started} ms)`
      );
    }
  }

  const manifestPath = join(outDir, ARCHIVE_MANIFEST);
  const previous = await readManifest(manifestPath);
  const keepPrevious = previous?.passphrase === passphrase ? previous.entries : [];
  await writeManifest(manifestPath, {
    version: 1,
    createdAt: new Date().toISOString(),
    passphrase,
    entries: mergeEntries(keepPrevious, recorded)
  });
  console.log(`Manifest: ${manifestPath}`);

  const failed = recorded.filter((entry) => entry.error || !entry.symptomReproduced);

  if (failed.length > 0) {
    throw new Error(
      `${failed.length} recording(s) failed or did not reproduce: ` +
        failed.map((entry) => `${entry.profile}/${entry.caseId}`).join(", ")
    );
  }
}

async function recordScenario(
  scenario: Scenario,
  profile: RecordingProfile,
  outDir: string,
  passphrase: string
): Promise<ManifestEntry> {
  const file = join(profile.id, `${scenario.caseId}.webblackbox`);
  const base = {
    caseId: scenario.caseId,
    scenarioId: scenario.id,
    profile: profile.id,
    file,
    recordedAt: new Date().toISOString()
  };
  const profileDir = join(
    tmpdir(),
    `webblackbox-evals-${profile.id}-${scenario.caseId}-${Date.now()}`
  );
  process.env.WB_E2E_PROFILE_DIR = profileDir;
  // Every recording gets a fresh site (server state) and a fresh browser profile.
  const site = await startBugZooSite(SCENARIOS);
  const harness = createProfileE2eHarness({
    name: `evals-${profile.id}-${scenario.caseId}`,
    defaultPort: DEFAULT_REMOTE_PORT
  });

  try {
    const { page, popup, swExceptions } = await harness.launch(`${site.origin}/`);
    await resetProfiles(popup);
    await runSteps(page, site.origin, scenario.setup ?? []);

    const tabId = await findTabId(popup, site.origin);
    // A background tab throttles timers and is not the one screenshots capture.
    await popup.evaluate(`chrome.tabs.update(${tabId}, { active: true }).then(() => true)`);
    const sid = await startRecording(page, popup, tabId, profile);

    await runSteps(page, site.origin, scenario.steps);
    const symptomReproduced = await page
      .evaluate(`Boolean(${scenario.symptom})`)
      .then((value) => value === true)
      .catch(() => false);
    await sleep(BEFORE_STOP_MS);

    const archivePath = await stopAndExport(popup, tabId, sid, passphrase, () =>
      harness.waitForDownload()
    );
    const target = join(outDir, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(archivePath, target);
    await rm(dirname(archivePath), { recursive: true, force: true });

    if (swExceptions.length > 0) {
      console.warn(`  service worker exceptions: ${swExceptions.join(" | ")}`);
    }

    // Chrome's log only matters when a recording fails.
    await rm(harness.chromeLogPath, { force: true });
    return { ...base, bytes: (await stat(target)).size, symptomReproduced };
  } catch (error) {
    return {
      ...base,
      bytes: 0,
      symptomReproduced: false,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await harness.stopBrowser();
    await harness.cleanup();
    await site.close();
    // Chrome's helpers may still be writing into the profile: retry, and never fail the run.
    await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(
      (error: unknown) => console.warn(`  could not remove ${profileDir}: ${String(error)}`)
    );
  }
}

/** No user profiles and no site rules, Maximum by default: what a fresh install records. */
async function resetProfiles(popup: CdpClient): Promise<void> {
  await popup.evaluate(`
    chrome.storage.local.set({
      "webblackbox.profiles": {
        schemaVersion: 2,
        defaultProfileId: "builtin:maximum",
        profiles: [],
        rules: [],
        extendedCaptureHosts: []
      }
    }).then(() => true)
  `);
}

async function findTabId(popup: CdpClient, origin: string): Promise<number> {
  const tabId = await popup.evaluate(`
    chrome.tabs.query({}).then((tabs) =>
      tabs.find((tab) => tab.url?.startsWith(${JSON.stringify(origin)}))?.id ?? null
    )
  `);

  if (typeof tabId !== "number") {
    throw new Error("Scenario tab not found");
  }

  return tabId;
}

async function startRecording(
  page: CdpClient,
  popup: CdpClient,
  tabId: number,
  profile: RecordingProfile
): Promise<string> {
  const message = {
    kind: "ui.start",
    tabId,
    mode: profile.mode,
    ...(profile.profileId ? { profileId: profile.profileId } : {}),
    ...(profile.visualCapture ? { visualCapture: profile.visualCapture } : {})
  };
  const indicator = JSON.stringify(`REC ${profile.mode}`);
  await popup.evaluate(`chrome.runtime.sendMessage(${JSON.stringify(message)})`);
  await waitFor(
    async () =>
      (await page.evaluate(
        `document.querySelector('[data-webblackbox-indicator="true"]')?.textContent?.includes(${indicator}) || null`
      )) as true | null,
    INDICATOR_TIMEOUT_MS,
    "Recording indicator did not appear"
  );
  await sleep(AFTER_START_MS);

  const sessions = await listSessions(popup);
  const sid = sessions.find((session) => session.active === true)?.sid;

  if (typeof sid !== "string") {
    throw new Error(`Active session not found: ${JSON.stringify(sessions)}`);
  }

  return sid;
}

async function stopAndExport(
  popup: CdpClient,
  tabId: number,
  sid: string,
  passphrase: string,
  waitForDownload: () => Promise<string>
): Promise<string> {
  const stopped = await popup.evaluate(
    `chrome.runtime.sendMessage({ kind: "ui.stop", tabId: ${tabId} })`
  );

  if (isRecord(stopped) && stopped.ok === false) {
    throw new Error(`Stop failed: ${JSON.stringify(stopped)}`);
  }

  await sleep(AFTER_STOP_MS);
  const exportMessage = { kind: "ui.export", sid, passphrase, saveAs: false };
  const exported = await popup.evaluate(
    `chrome.runtime.sendMessage(${JSON.stringify(exportMessage)})`
  );

  if (!isRecord(exported) || exported.ok !== true) {
    throw new Error(`Export failed: ${JSON.stringify(exported)}`);
  }

  return waitForDownload();
}

type SessionRow = { sid?: unknown; active?: unknown };

async function listSessions(popup: CdpClient): Promise<SessionRow[]> {
  const sessions = await popup.evaluate(
    `chrome.runtime.sendMessage({ kind: "ui.request-session-list" }).then((list) => list?.sessions ?? [])`
  );

  return Array.isArray(sessions) ? (sessions as SessionRow[]) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
