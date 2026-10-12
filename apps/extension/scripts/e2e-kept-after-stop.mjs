#!/usr/bin/env node

// E2E: a stopped recording nobody exported is kept until it is exported or deleted. After Stop
// the session asks for its export (`exportPrompt`, SAVE badge); its stopped record never expires
// and no retention alarm is set (the old default deleted it after 10 minutes). It is still listed
// after the service worker restarts. "Later" puts the prompt off and keeps the recording; the
// export deletes it. The export passphrase is remembered for the browser session, so a second
// recording exports without one.

import { createServer } from "node:http";

import { EXTENSION_FILES } from "./lib/extension-paths.mjs";
import { assert, createProfileE2eHarness, sleep, waitFor } from "./lib/profile-e2e-harness.mjs";

const harness = createProfileE2eHarness({ name: "kept-after-stop", defaultPort: "9242" });
const passphrase = "webblackbox-kept-e2e";
const STOPPED_SESSIONS_KEY = "webblackbox.runtime.stoppedSessions";
const RETENTION_ALARM_PREFIX = "webblackbox.retention:";
const WORKER_IDLE_WAIT_MS = 2_000;

main().catch(async (error) => {
  console.error(
    "Kept after Stop E2E failed:",
    error instanceof Error ? error.message : String(error)
  );
  await harness.cleanup();
  process.exit(1);
});

async function main() {
  const pageUrl = await startServer();
  const { browser, popup, swExceptions, extensionId } = await harness.launch(pageUrl);
  const listSessions = () =>
    popup.evaluate(
      `chrome.runtime.sendMessage({ kind: "ui.request-session-list" }).then((list) => list?.sessions ?? [])`
    );
  const badge = () => popup.evaluate(`chrome.action.getBadgeText({})`);
  const tabId = await popup.evaluate(`
    chrome.tabs.query({}).then((tabs) =>
      tabs.find((tab) => tab.url?.startsWith(${JSON.stringify(pageUrl)}))?.id ?? null
    )
  `);
  assert(typeof tabId === "number", "Page tab not found", { tabId });

  const sid = await recordAndStop(popup, tabId, listSessions);
  const stopped = (await listSessions()).find((session) => session.sid === sid);
  assert(
    stopped?.exportPrompt === true,
    "The stopped recording does not ask for its export",
    stopped
  );
  await waitFor(
    async () => ((await badge()) === "SAVE" ? true : null),
    10_000,
    "The badge does not ask for the export"
  );

  const record = await popup.evaluate(`
    chrome.storage.local.get(${JSON.stringify(STOPPED_SESSIONS_KEY)}).then((values) =>
      (values[${JSON.stringify(STOPPED_SESSIONS_KEY)}] ?? []).find((row) => row.sid === ${JSON.stringify(sid)}) ?? null
    )
  `);
  assert(
    record?.expiresAt === Number.MAX_SAFE_INTEGER,
    "The stopped recording still has an expiry",
    record
  );
  const alarms = await popup.evaluate(
    `chrome.alarms.getAll().then((all) => all.map((alarm) => alarm.name))`
  );
  assert(
    !alarms.some((name) => name.startsWith(RETENTION_ALARM_PREFIX)),
    "A retention alarm would delete the unexported recording",
    alarms
  );

  // Chrome stops idle workers: the recording and its prompt survive that.
  const origin = `chrome-extension://${extensionId}`;
  const swTarget = (await harness.listTargets()).find(
    (target) => target.type === "service_worker" && target.url === `${origin}/${EXTENSION_FILES.serviceWorker}`
  );
  assert(swTarget, "Extension service worker target not found");
  await browser.send("Target.closeTarget", { targetId: swTarget.id });
  await waitFor(
    async () =>
      (await harness.listTargets()).some((target) => target.id === swTarget.id) ? null : true,
    10_000,
    "The service worker did not stop"
  );
  await sleep(WORKER_IDLE_WAIT_MS);
  const restored = await waitFor(
    async () => (await listSessions()).find((session) => session.sid === sid) ?? null,
    15_000,
    "The stopped recording is not listed after the service worker restart"
  );
  assert(restored.exportPrompt === true, "The export prompt was lost in the restart", restored);

  // "Later": the prompt and the badge go, the recording stays.
  await popup.evaluate(
    `chrome.runtime.sendMessage({ kind: "ui.dismiss-export", sid: ${JSON.stringify(sid)} })`
  );
  const later = await waitFor(
    async () => {
      const session = (await listSessions()).find((entry) => entry.sid === sid);
      return session && !session.exportPrompt ? session : null;
    },
    10_000,
    "Later did not put the export prompt off"
  );
  assert(later.active === false, "Later changed the recording", later);
  assert((await badge()) !== "SAVE", "The badge still asks for the export after Later");

  const exported = await popup.evaluate(`
    chrome.runtime.sendMessage({
      kind: "ui.export",
      sid: ${JSON.stringify(sid)},
      passphrase: ${JSON.stringify(passphrase)},
      saveAs: false
    })
  `);
  assert(exported?.ok === true, "Export failed", exported);
  await waitFor(
    async () => ((await listSessions()).some((session) => session.sid === sid) ? null : true),
    15_000,
    "The exported recording was not deleted"
  );

  // The passphrase is remembered for the browser session: the next export does not need it.
  const secondSid = await recordAndStop(popup, tabId, listSessions);
  const second = await popup.evaluate(`
    chrome.runtime.sendMessage({ kind: "ui.export", sid: ${JSON.stringify(secondSid)}, saveAs: false })
  `);
  assert(second?.ok === true, "Export with the remembered passphrase failed", second);
  assert(swExceptions.length === 0, "Service worker threw", swExceptions);

  console.log(`Kept record: ${JSON.stringify(record)}`);
  console.log("Kept after Stop E2E passed.");
  await harness.cleanup();
}

async function recordAndStop(popup, tabId, listSessions) {
  await popup.evaluate(`chrome.runtime.sendMessage({ kind: "ui.start", tabId: ${tabId} })`);
  const session = await waitFor(
    async () => (await listSessions()).find((entry) => entry.active) ?? null,
    25_000,
    "The recording did not start"
  );
  await sleep(2_000);
  await popup.evaluate(`chrome.runtime.sendMessage({ kind: "ui.stop", tabId: ${tabId} })`);
  await waitFor(
    async () =>
      (await listSessions()).find((entry) => entry.sid === session.sid && !entry.active) ?? null,
    20_000,
    "The recording did not stop"
  );
  return session.sid;
}

function startServer() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><html><head><title>kept after stop</title></head>" +
        "<body><h1>WebBlackbox kept-after-stop fixture</h1></body></html>"
    );
  });
  harness.trackServer(server);

  return new Promise((resolveUrl) => {
    server.listen(0, "127.0.0.1", () => {
      resolveUrl(`http://127.0.0.1:${server.address().port}/`);
    });
  });
}
