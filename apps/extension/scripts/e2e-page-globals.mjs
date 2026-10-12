#!/usr/bin/env node

// E2E: recording never adds or replaces a global of the recorded page.
//
// The page hooks (`injected.js`) run as a classic script in the page's own (MAIN) world. A
// top-level binding of the bundle once became a page global: the minified `$` overwrote jQuery's
// on a real site (#48). This check guards the whole class, in Lite and Full: it snapshots every own
// property of `window` with its descriptor before Start, then compares after Start, after captured
// actions and after Stop. Any new property outside ALLOWED_PAGE_GLOBALS, any removed one, and any
// own property whose value or accessors changed fails the run. The snapshot lives in a CDP object
// handle, so the check itself defines nothing in the page.

import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, createProfileE2eHarness, sleep, waitFor } from "./lib/profile-e2e-harness.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(root, "..");
const harness = createProfileE2eHarness({ name: "page-globals", appRoot, defaultPort: "9241" });
const MODES = ["lite", "full"];
const SETTLE_MS = 1_500;
const SNAPSHOT_GROUP = "wb-page-globals";

/**
 * Page-world names the product defines on purpose (packages/webblackbox/src/injected-hooks.ts).
 * Keep this list minimal: every entry is visible to the recorded page.
 */
const ALLOWED_PAGE_GLOBALS = new Set([
  // Install-once flag of the page hooks: a second injection only pushes new config.
  "__WEBBLACKBOX_INJECTED__",
  // Non-enumerable, non-writable setter through which the service worker hands the hooks the
  // per-session bridge nonce (scripting.executeScript, never a DOM event).
  "__WEBBLACKBOX_SET_BRIDGE_NONCE__"
]);

/** Page-owned globals whose identity must survive the recording: a function and objects. */
const PAGE_OWNED_GLOBALS = ["$", "pageState", "pageHelpers"];

main().catch(async (error) => {
  console.error("Page globals E2E failed:", error instanceof Error ? error.message : String(error));
  await harness.cleanup();
  process.exit(1);
});

async function main() {
  const origin = await startPageServer();
  const { popup, swExceptions } = await harness.launch("about:blank");
  const report = {};

  for (const mode of MODES) {
    report[mode] = await runMode(mode, origin, popup);
  }

  assert(swExceptions.length === 0, "Service worker threw", swExceptions);
  console.log(JSON.stringify(report, null, 2));
  console.log("Page globals E2E passed.");
  await harness.cleanup();
}

async function runMode(mode, origin, popup) {
  const url = `${origin}/page/?mode=${mode}`;
  const { client, targetId } = await harness.openPage(url);
  await client.send("Runtime.enable");
  await waitFor(
    () => client.evaluate(`document.readyState === "complete" || null`),
    15_000,
    `Fixture page did not load (${mode})`
  );
  // Lazily created globals (if any) appear before the snapshot, not during the recording.
  await performPageActions(client);
  await sleep(SETTLE_MS);

  const snapshot = await snapshotGlobals(client);
  const tabId = await popup.evaluate(
    `chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === ${JSON.stringify(url)})?.id ?? null)`
  );
  assert(typeof tabId === "number", `Fixture tab not found (${mode})`, { url });

  const started = await popup.evaluate(
    `chrome.runtime.sendMessage({ kind: "ui.start", tabId: ${tabId}, mode: ${JSON.stringify(mode)}, visualCapture: "none" })`
  );
  assert(started?.ok !== false, `Start was rejected (${mode})`, started);
  await waitForIndicator(client, true, mode);
  await waitFor(
    () => client.evaluate(`window.__WEBBLACKBOX_INJECTED__ === true || null`),
    15_000,
    `Page hooks did not run (${mode})`
  );
  await sleep(SETTLE_MS);
  const afterStart = await diffGlobals(client, snapshot, `${mode}: after Start`);

  await performPageActions(client);
  await sleep(SETTLE_MS);
  const afterActions = await diffGlobals(client, snapshot, `${mode}: after captured actions`);

  const stopped = await popup.evaluate(
    `chrome.runtime.sendMessage({ kind: "ui.stop", tabId: ${tabId} })`
  );
  assert(stopped?.ok !== false, `Stop was rejected (${mode})`, stopped);
  await waitForIndicator(client, false, mode);
  await sleep(SETTLE_MS);
  const afterStop = await diffGlobals(client, snapshot, `${mode}: after Stop`);

  await client.send("Runtime.releaseObjectGroup", { objectGroup: SNAPSHOT_GROUP });
  await harness.closePage(targetId);

  return {
    globals: snapshot.count,
    productGlobals: afterStop.allowedAdded,
    checks: [afterStart.label, afterActions.label, afterStop.label]
  };
}

/** Keeps the page's own properties and their descriptors in a CDP handle (nothing in the page). */
async function snapshotGlobals(client) {
  const { result, exceptionDetails } = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const descriptors = new Map();
      for (const name of Object.getOwnPropertyNames(window)) {
        descriptors.set(name, Object.getOwnPropertyDescriptor(window, name));
      }
      return { descriptors };
    })()`,
    objectGroup: SNAPSHOT_GROUP,
    returnByValue: false
  });
  assert(!exceptionDetails && result?.objectId, "Could not snapshot the page globals", {
    exceptionDetails
  });
  const count = await callOnSnapshot(
    client,
    result.objectId,
    `function () {
      return this.descriptors.size;
    }`
  );
  return { objectId: result.objectId, count };
}

async function diffGlobals(client, snapshot, label) {
  const diff = await callOnSnapshot(
    client,
    snapshot.objectId,
    `function (pageOwned) {
      const before = this.descriptors;
      const same = (left, right) => left === right || (left !== left && right !== right);
      const added = Object.getOwnPropertyNames(window).filter((name) => !before.has(name));
      const removed = [];
      const changed = [];

      for (const [name, previous] of before) {
        const current = Object.getOwnPropertyDescriptor(window, name);

        if (!current) {
          removed.push(name);
          continue;
        }

        if (
          !same(previous.value, current.value) ||
          previous.get !== current.get ||
          previous.set !== current.set
        ) {
          changed.push(name);
        }
      }

      const lostIdentity = pageOwned.filter(
        (name) => !before.has(name) || before.get(name).value !== window[name]
      );
      return { added, removed, changed, lostIdentity };
    }`,
    [PAGE_OWNED_GLOBALS]
  );
  const unexpected = diff.added.filter((name) => !ALLOWED_PAGE_GLOBALS.has(name));

  assert(unexpected.length === 0, `New page globals ${label}`, { unexpected, ...diff });
  assert(diff.removed.length === 0, `Page globals removed ${label}`, diff);
  assert(diff.changed.length === 0, `Page globals replaced ${label}`, diff);
  assert(diff.lostIdentity.length === 0, `Page-owned globals lost identity ${label}`, diff);

  const jQuery = await client.evaluate(`typeof $ === "function" && $.isPageJQuery === true`);
  assert(jQuery, `The page's $ was replaced ${label}`);

  return { label, allowedAdded: diff.added };
}

async function callOnSnapshot(client, objectId, functionDeclaration, args = []) {
  const { result, exceptionDetails } = await client.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration,
    arguments: args.map((value) => ({ value })),
    returnByValue: true
  });
  assert(!exceptionDetails, "Page globals comparison threw", exceptionDetails);
  return result?.value;
}

/** What a recording captures: a click, typing, scrolling, console, fetch, XHR and storage. */
async function performPageActions(client) {
  await client.evaluate(`(() => {
    document.getElementById("act").click();
    const input = document.getElementById("field");
    input.focus();
    input.value = "typed";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    window.scrollTo(0, 200);
    return true;
  })()`);
  await client.evaluate(`window.pageHelpers.request()`);
}

function waitForIndicator(client, present, mode) {
  return waitFor(
    async () =>
      (await client.evaluate(
        `Boolean(document.querySelector('[data-webblackbox-indicator="true"]'))`
      )) === present
        ? true
        : null,
    25_000,
    `Recording indicator did not ${present ? "appear" : "clear"} (${mode})`
  );
}

async function startPageServer() {
  // The page's own globals: a jQuery-like `$`, a state object and a helper object. Handlers only
  // mutate objects, never rebind a global, so any change to `window` comes from the recorder.
  const page = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Page globals</title></head>
  <body style="min-height: 2000px">
    <h1>Page globals</h1>
    <button id="act" type="button">Act</button>
    <input id="field" type="text" />
    <script>
      window.$ = Object.assign(() => [], { isPageJQuery: true });
      window.pageState = { clicks: 0 };
      window.pageHelpers = {
        async request() {
          await fetch("/api/ping").then((response) => response.text());
          await new Promise((done) => {
            const xhr = new XMLHttpRequest();
            xhr.open("GET", "/api/ping?xhr=1");
            xhr.onloadend = () => done();
            xhr.send();
          });
          return true;
        }
      };
      document.getElementById("act").addEventListener("click", () => {
        window.pageState.clicks += 1;
        console.log("page-globals click", window.pageState.clicks);
        localStorage.setItem("page-globals", String(window.pageState.clicks));
        sessionStorage.setItem("page-globals", String(window.pageState.clicks));
      });
    </script>
  </body>
</html>`;
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://127.0.0.1");

    if (pathname === "/api/ping") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
      return;
    }

    const isPage = pathname === "/page/";
    response.writeHead(isPage ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    response.end(isPage ? page : "not found");
  });

  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  harness.trackServer(server);
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}
