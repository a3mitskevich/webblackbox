#!/usr/bin/env node

// E2E: when the content script runs in pages, for both injection modes.
//
// "always" (default): the all-sites registration injects content.js into every page and frame.
// "on-start": no page runs content.js until Start; then the recorded tab gets it in every frame,
// including after a reload, a navigation and in an iframe added after Start, while other tabs
// stay clean. Presence is checked over CDP: an isolated-world execution context of the extension
// in which the content-script guard is set. The recorded tab also embeds a cross-origin
// (out-of-process) iframe; its CDP contexts are not visible from the page target, so it is checked
// by the events it sends to the service worker after Start, a reload and a navigation.
//
// WB_E2E_INJECTION_BENCH=1 runs the idle-cost bench instead: N tabs (WB_E2E_INJECTION_BENCH_TABS,
// default 50) of a page with one iframe, per mode, reporting what reached the service worker and
// how many frames run content.js.

import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, createProfileE2eHarness, sleep, waitFor } from "./lib/profile-e2e-harness.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(root, "..");
const harness = createProfileE2eHarness({ name: "injection", appRoot, defaultPort: "9237" });
const benchMode = process.env.WB_E2E_INJECTION_BENCH === "1";
const benchTabs = readPositiveInteger(process.env.WB_E2E_INJECTION_BENCH_TABS, 50);
const SCRIPT_ID = "webblackbox-content";
const CONTENT_PORT = "webblackbox:content";
const SETTLE_MS = 1_500;
const CROSS_ORIGIN_FRAME_PATH = "/xframe/";

main().catch(async (error) => {
  console.error("Injection E2E failed:", error instanceof Error ? error.message : String(error));
  await harness.cleanup();
  process.exit(1);
});

async function main() {
  const origin = await startPageServer();
  const { popup, sw, swExceptions, extensionId } = await harness.launch("about:blank");
  const swWarnings = [];
  sw.on("Runtime.consoleAPICalled", ({ type, args }) => {
    if (type === "warning" || type === "error") {
      swWarnings.push(args?.map((arg) => arg.value ?? arg.description ?? "").join(" "));
    }
  });
  // Re-enabling replays what the worker logged before this script subscribed.
  await sw.send("Runtime.disable");
  await sw.send("Runtime.enable");
  const extension = createExtensionControl(popup, sw, swWarnings);

  await extension.installSwStats();
  await extension.waitForRegistration(true);

  const report = benchMode
    ? await runBench(origin, extension, extensionId)
    : await runScenarios(origin, extension, extensionId);

  assert(swExceptions.length === 0, "Service worker threw", swExceptions);
  console.log(JSON.stringify(report, null, 2));
  console.log(benchMode ? "Injection idle bench passed." : "Injection E2E passed.");
  await harness.cleanup();
}

async function runScenarios(origin, extension, extensionId) {
  const report = {};

  // Default: every new page runs the content script, iframes included.
  const always = await openTrackedPage(`${origin}/page/?tab=always`, extensionId);
  report.alwaysIdle = await always.contentScriptFrames();
  assert(report.alwaysIdle.length === 2, "Always: page and iframe should run content.js", report);

  await extension.setInjectionMode("on-start");
  await extension.waitForRegistration(false);

  // On demand: nothing before Start.
  const recordedUrl = `${origin}/page/?tab=recorded&xo=1`;
  const recorded = await openTrackedPage(recordedUrl, extensionId);
  report.onDemandIdle = await recorded.contentScriptFrames();
  assert(report.onDemandIdle.length === 0, "On demand: content.js ran before Start", report);
  assert(!(await recorded.hasIndicator()), "On demand: indicator before Start", report);

  const tabId = await extension.tabIdFor(recordedUrl);
  await extension.readSwStats(true);
  const start = await extension.start(tabId);
  assert(start?.ok !== false, "Start was rejected", start);
  await recorded.waitForIndicator(true);
  report.onDemandStarted = await recorded.waitForFrames(2);

  // An iframe added after Start gets the script when it commits.
  await recorded.evaluate(`(() => {
    const frame = document.createElement("iframe");
    frame.src = "/frame/?late=1";
    document.body.append(frame);
    return true;
  })()`);
  report.onDemandLateIframe = await recorded.waitForFrames(3);
  await recorded.clickInFrames();
  report.crossOriginAfterStart = await expectCrossOriginFrameEvents(recorded, extension);

  await recorded.reload();
  await recorded.waitForIndicator(true);
  report.onDemandAfterReload = await recorded.waitForFrames(2);
  report.crossOriginAfterReload = await expectCrossOriginFrameEvents(recorded, extension);

  await recorded.evaluate(`(location.assign("/next/?tab=recorded&xo=1"), true)`);
  await waitFor(
    () =>
      recorded.evaluate(
        `(location.pathname === "/next/" && document.readyState === "complete") || null`
      ),
    15_000,
    "Navigation to /next/ did not finish"
  );
  await recorded.waitForIndicator(true);
  report.onDemandAfterNavigation = await recorded.waitForFrames(2);
  report.crossOriginAfterNavigation = await expectCrossOriginFrameEvents(recorded, extension);
  await recorded.clickInFrames();

  // Another tab opened during the recording stays clean.
  const bystander = await openTrackedPage(`${origin}/page/?tab=bystander`, extensionId);
  report.onDemandBystander = await bystander.contentScriptFrames();
  assert(
    report.onDemandBystander.length === 0,
    "On demand: content.js in a tab not recorded",
    report
  );

  await sleep(SETTLE_MS);
  const stats = await extension.readSwStats(true);
  report.recordingStats = stats;
  const eventFrames = Object.keys(stats.contentEvents).map(Number);
  assert(eventFrames.includes(0), "No page events reached the service worker", stats);
  assert(
    eventFrames.some((frameId) => frameId > 0),
    "No iframe events reached the service worker",
    stats
  );

  await extension.stop(tabId);
  await recorded.waitForIndicator(false);

  // After Stop nothing re-injects on navigation any more.
  await recorded.reload();
  report.onDemandAfterStop = await recorded.contentScriptFrames();
  assert(report.onDemandAfterStop.length === 0, "On demand: content.js after Stop", report);

  await extension.setInjectionMode("always");
  await extension.waitForRegistration(true);
  const restored = await openTrackedPage(`${origin}/page/?tab=restored`, extensionId);
  report.alwaysRestored = await restored.contentScriptFrames();
  assert(report.alwaysRestored.length === 2, "Always again: content.js missing", report);

  return summarizeFrames(report);
}

async function runBench(origin, extension, extensionId) {
  const results = [];

  for (const mode of ["always", "on-start"]) {
    await extension.setInjectionMode(mode);
    await extension.waitForRegistration(mode === "always");
    await extension.readSwStats(true);

    const startedAt = Date.now();
    const pages = [];

    for (let index = 0; index < benchTabs; index += 1) {
      pages.push(
        await openTrackedPage(`${origin}/page/?bench=${mode}-${index}`, extensionId, {
          settleMs: 0
        })
      );
    }

    const loadMs = Date.now() - startedAt;
    await sleep(SETTLE_MS);
    const stats = await extension.readSwStats(true);
    let framesWithContentScript = 0;
    let tabsWithContentScript = 0;
    let heapBytes = 0;

    for (const page of pages) {
      const frames = await page.contentScriptFrames();
      framesWithContentScript += frames.length;
      tabsWithContentScript += frames.length > 0 ? 1 : 0;
      heapBytes += await page.jsHeapUsedBytes();
    }

    for (const page of pages) {
      await page.close();
    }

    results.push({
      mode,
      tabs: benchTabs,
      framesPerTab: 2,
      tabsWithContentScript,
      framesWithContentScript,
      swRuntimeMessages: stats.messageTotal,
      swMessagesByKind: stats.messages,
      swContentPortConnects: stats.connects,
      avgJsHeapKbPerTab: Math.round(heapBytes / benchTabs / 1024),
      openAllTabsMs: loadMs
    });
  }

  const onDemand = results.find((row) => row.mode === "on-start");
  const always = results.find((row) => row.mode === "always");
  assert(onDemand?.framesWithContentScript === 0, "On demand: content.js in idle tabs", results);
  assert(onDemand?.swRuntimeMessages === 0, "On demand: idle tabs messaged the worker", results);
  assert(
    always?.framesWithContentScript === benchTabs * 2,
    "Always: content.js missing in some frames",
    results
  );

  console.table(results, [
    "mode",
    "tabs",
    "framesPerTab",
    "tabsWithContentScript",
    "framesWithContentScript",
    "swRuntimeMessages",
    "swContentPortConnects",
    "avgJsHeapKbPerTab",
    "openAllTabsMs"
  ]);
  return { bench: results };
}

/**
 * Clicks inside the cross-origin iframe and waits until its content script delivers events: the
 * frame lives in another renderer, so only the service worker sees whether it runs content.js.
 */
async function expectCrossOriginFrameEvents(page, extension) {
  await extension.readSwStats(true);
  await page.clickCrossOriginFrame();

  return waitFor(
    async () => {
      const stats = await extension.readSwStats(false);
      const events = stats.contentEventsByPath[CROSS_ORIGIN_FRAME_PATH] ?? 0;
      return events > 0 ? { events } : null;
    },
    15_000,
    "No events from the cross-origin iframe reached the service worker"
  );
}

function summarizeFrames(report) {
  return Object.fromEntries(
    Object.entries(report).map(([key, value]) => [
      key,
      Array.isArray(value) ? { frames: value.length } : value
    ])
  );
}

function createExtensionControl(popup, sw, swWarnings) {
  return {
    async installSwStats() {
      await sw.evaluate(`(() => {
        const stats = { messages: {}, connects: 0, contentEvents: {}, contentEventsByPath: {} };
        globalThis.__wbInjectionE2e = stats;
        chrome.runtime.onMessage.addListener((message) => {
          const kind = typeof message?.kind === "string" ? message.kind : "unknown";
          stats.messages[kind] = (stats.messages[kind] ?? 0) + 1;
        });
        chrome.runtime.onConnect.addListener((port) => {
          if (port.name !== ${JSON.stringify(CONTENT_PORT)}) {
            return;
          }

          stats.connects += 1;
          const frameId = port.sender?.frameId ?? -1;
          let path = "unknown";
          try {
            path = new URL(port.sender?.url ?? "").pathname;
          } catch {}
          port.onMessage.addListener((message) => {
            if (message?.kind === "content.events" && Array.isArray(message.events)) {
              stats.contentEvents[frameId] = (stats.contentEvents[frameId] ?? 0) + message.events.length;
              stats.contentEventsByPath[path] =
                (stats.contentEventsByPath[path] ?? 0) + message.events.length;
            }
          });
        });
        return true;
      })()`);
    },
    async readSwStats(reset) {
      return sw.evaluate(`(() => {
        const stats = globalThis.__wbInjectionE2e;
        const snapshot = JSON.parse(JSON.stringify(stats));
        snapshot.messageTotal = Object.values(snapshot.messages).reduce((sum, count) => sum + count, 0);

        if (${JSON.stringify(reset)}) {
          stats.messages = {};
          stats.connects = 0;
          stats.contentEvents = {};
          stats.contentEventsByPath = {};
        }

        return snapshot;
      })()`);
    },
    setInjectionMode(mode) {
      return popup.evaluate(
        `chrome.storage.local.set({ "webblackbox.injection": ${JSON.stringify(mode)} }).then(() => true)`
      );
    },
    async waitForRegistration(expected) {
      let lastIds = null;

      try {
        return await waitFor(
          async () => {
            lastIds = await popup.evaluate(
              `chrome.scripting.getRegisteredContentScripts().then((scripts) => scripts.map((script) => script.id))`
            );
            return lastIds.includes(SCRIPT_ID) === expected ? true : null;
          },
          20_000,
          `Content script registration did not become ${expected ? "present" : "absent"}`
        );
      } catch (error) {
        const stored = await popup
          .evaluate(`chrome.storage.local.get("webblackbox.injection")`)
          .catch(() => null);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} | ${JSON.stringify({
            lastIds,
            stored,
            swWarnings
          })}`
        );
      }
    },
    tabIdFor(url) {
      return popup.evaluate(
        `chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === ${JSON.stringify(url)})?.id ?? null)`
      );
    },
    start(tabId) {
      return popup.evaluate(
        `chrome.runtime.sendMessage({ kind: "ui.start", tabId: ${tabId}, mode: "lite" })`
      );
    },
    stop(tabId) {
      return popup.evaluate(`chrome.runtime.sendMessage({ kind: "ui.stop", tabId: ${tabId} })`);
    }
  };
}

/** A tab with its execution contexts tracked, loaded and settled. */
async function openTrackedPage(url, extensionId, { settleMs = SETTLE_MS } = {}) {
  const { client, targetId } = await harness.openPage(url);
  const contexts = new Map();
  client.on("Runtime.executionContextCreated", ({ context }) => contexts.set(context.id, context));
  client.on("Runtime.executionContextDestroyed", ({ executionContextId }) =>
    contexts.delete(executionContextId)
  );
  client.on("Runtime.executionContextsCleared", () => contexts.clear());
  await client.send("Runtime.enable");
  await client.send("Page.enable");

  const evaluate = (expression) => client.evaluate(expression);
  const waitForLoad = () =>
    waitFor(
      () =>
        evaluate(`(document.readyState === "complete" && location.href !== "about:blank") || null`),
      15_000,
      `Page did not load: ${url}`
    );

  /** Frame ids whose isolated world runs this extension's content script. */
  async function contentScriptFrames() {
    const frames = [];

    for (const context of contexts.values()) {
      if (context.auxData?.type !== "isolated") {
        continue;
      }

      const result = await client
        .send("Runtime.evaluate", {
          expression: `chrome?.runtime?.id === ${JSON.stringify(extensionId)} &&
            globalThis.__webblackboxContentScript__?.isAlive?.() === true`,
          contextId: context.id,
          returnByValue: true
        })
        .catch(() => null);

      if (result?.result?.value === true) {
        frames.push(context.auxData.frameId);
      }
    }

    return frames;
  }

  await waitForLoad();
  await sleep(settleMs);

  return {
    evaluate,
    contentScriptFrames,
    async waitForFrames(count) {
      return waitFor(
        async () => {
          const frames = await contentScriptFrames();
          return frames.length >= count ? frames : null;
        },
        15_000,
        `Expected content.js in ${count} frame(s) of ${url}`
      );
    },
    async hasIndicator() {
      return evaluate(`Boolean(document.querySelector('[data-webblackbox-indicator="true"]'))`);
    },
    async waitForIndicator(present) {
      return waitFor(
        async () =>
          (await evaluate(
            `Boolean(document.querySelector('[data-webblackbox-indicator="true"]'))`
          )) === present
            ? true
            : null,
        25_000,
        `Recording indicator did not ${present ? "appear" : "clear"}`
      );
    },
    async clickInFrames() {
      await evaluate(`(() => {
        document.getElementById("act")?.click();
        for (const frame of document.querySelectorAll("iframe")) {
          frame.contentDocument?.getElementById("inner")?.click();
        }
        return true;
      })()`);
    },
    /** A real pointer click routed by the browser into the out-of-process iframe. */
    async clickCrossOriginFrame() {
      const rect = await evaluate(`(() => {
        const box = document.getElementById("xchild")?.getBoundingClientRect();
        return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
      })()`);
      assert(rect, "Cross-origin iframe missing", { url });

      for (const type of ["mousePressed", "mouseReleased"]) {
        await client.send("Input.dispatchMouseEvent", {
          type,
          x: rect.x,
          y: rect.y,
          button: "left",
          clickCount: 1
        });
      }
    },
    async reload() {
      await client.send("Page.reload", { ignoreCache: true });
      await sleep(300);
      await waitForLoad();
      await sleep(SETTLE_MS);
    },
    async jsHeapUsedBytes() {
      await client.send("Performance.enable").catch(() => undefined);
      const { metrics } = await client.send("Performance.getMetrics");
      return metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? 0;
    },
    close() {
      return harness.closePage(targetId);
    }
  };
}

async function startPageServer() {
  let crossOrigin = "";
  const page = (title, withCrossOriginFrame) => `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>${title}</title></head>
  <body>
    <h1>${title}</h1>
    <button id="act" type="button">Act</button>
    <a id="next" href="/next/">Next</a>
    <iframe id="child" src="/frame/" width="240" height="80"></iframe>
    ${
      withCrossOriginFrame
        ? `<iframe id="xchild" src="${crossOrigin}${CROSS_ORIGIN_FRAME_PATH}" width="240" height="80"></iframe>`
        : ""
    }
    <script>
      document.getElementById("act").addEventListener("click", () => {
        console.log("injection-e2e act");
        fetch("/api/ping").catch(() => undefined);
      });
    </script>
  </body>
</html>`;
  const frame = `<!doctype html><html><body style="margin:0"><button id="inner" type="button" style="width:100%;height:100vh">Inner</button></body></html>`;
  const routes = {
    "/page/": (withCrossOriginFrame) => page("Injection page", withCrossOriginFrame),
    "/next/": (withCrossOriginFrame) => page("Injection next", withCrossOriginFrame),
    "/frame/": () => frame,
    [CROSS_ORIGIN_FRAME_PATH]: () => frame
  };
  const server = createServer((request, response) => {
    const { pathname, searchParams } = new URL(request.url ?? "/", "http://127.0.0.1");

    if (pathname === "/api/ping") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
      return;
    }

    const body = routes[pathname]?.(searchParams.has("xo"));
    response.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    response.end(body ?? "not found");
  });

  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  harness.trackServer(server);
  const { port } = server.address();
  // Another site than the page (127.0.0.1), so Chrome puts the iframe in its own process.
  crossOrigin = `http://localhost:${port}`;
  return `http://127.0.0.1:${port}`;
}

function readPositiveInteger(value, fallback) {
  const numeric = Number(value ?? fallback);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}
