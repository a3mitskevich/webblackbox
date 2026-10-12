#!/usr/bin/env node

// One measured rrweb recording (task 56 spike harness, kept for task 60 and later rrweb
// upgrades): before/after page overhead, archive size, masking and click attribution. Not a CI gate.
//
// Records a scripted session on the heavy SPA fixture or the realistic site with one extension
// build (WB_E2E_EXTENSION_DIR: a default build = "now", a WB_RRWEB_RRWEB=1 build = "rrweb", or
// WB_RRWEB_VARIANT=off to measure the page without recording), then:
// - page overhead: Performance.getMetrics deltas, long tasks, JS heap;
// - archive: size, bytes per DOM event type;
// - masking: which planted secrets reach the decrypted archive;
// - clicks: whether each scripted click is attributed to the clicked element (rrweb node ids
//   resolved through the recorded node tree, and our own user.click targets);
// - with WB_RRWEB_PLAYER=1 (rrweb only): opens the archive in the built Player, the DOM replay
//   tab, steps through the clicks and records the highlight results and seek times.
//
// WB_RRWEB_HEAVY_ROWS sizes the heavy SPA (default 2,500 rows). WB_RRWEB_SITE=heavy|realistic, WB_E2E_MODE=lite|full,
// WB_RRWEB_PROFILE=light (masked; alias "default")|maximum (raw; alias "full-capture")|dom-allow, WB_RRWEB_DURATION_MS, WB_RRWEB_CLICK_EVERY_MS, WB_RRWEB_OUT (JSON),
// WB_RRWEB_SCREENSHOT (PNG of the Player), WB_RRWEB_RELOAD_AFTER_START=1 (resources load inside
// the recording, so their bodies can reach the archive), WB_RRWEB_ARCHIVE_OUT (a copy of the
// archive, passphrase "webblackbox-rrweb-measure"). Wrap it in `timeout`.

import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assert, createProfileE2eHarness, sleep, waitFor } from "./lib/profile-e2e-harness.mjs";
import { HEAVY_SECRETS, startHeavySpa } from "./lib/heavy-spa.mjs";
import { startRealisticSite } from "./lib/realistic-site.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(root, "..");
const repoRoot = resolve(appRoot, "..", "..");
const site = process.env.WB_RRWEB_SITE ?? "heavy";
const mode = process.env.WB_E2E_MODE ?? "lite";
const variant = process.env.WB_RRWEB_VARIANT ?? "recording";
/** Earlier names of the choices, from before the Maximum / Light presets (task 61). */
const PROFILE_ALIASES = { default: "light", "full-capture": "maximum" };
const requestedProfile = process.env.WB_RRWEB_PROFILE ?? "light";
const profileChoice = PROFILE_ALIASES[requestedProfile] ?? requestedProfile;
const durationMs = Number(process.env.WB_RRWEB_DURATION_MS ?? 60_000);
const clickEveryMs = Number(process.env.WB_RRWEB_CLICK_EVERY_MS ?? 4_000);
const checkPlayer = process.env.WB_RRWEB_PLAYER === "1";
const passphrase = "webblackbox-rrweb-measure";
const harness = createProfileE2eHarness({ name: "rrweb-measure", appRoot, defaultPort: "9271" });
const DOM_ALLOW_PROFILE_ID = "measure-dom-allow";

main().catch(async (error) => {
  console.error("rrweb measurement failed:", error instanceof Error ? error.stack : String(error));
  await harness.cleanup();
  process.exit(1);
});

async function main() {
  const protocol = await import(
    pathToFileURL(resolve(repoRoot, "packages/protocol/dist/index.js")).href
  );
  const { RrwebDomReplay, WebBlackboxPlayer } = await import(
    pathToFileURL(resolve(repoRoot, "packages/player-sdk/dist/index.js")).href
  );
  const heavyRows = Number(process.env.WB_RRWEB_HEAVY_ROWS ?? 0) || undefined;
  const server =
    site === "heavy" ? await startHeavySpa({ rows: heavyRows }) : await startRealisticSite();
  harness.trackServer(server.server);
  const { page, popup, browser } = await harness.launch(server.pageUrl);
  await page.send("Performance.enable", { timeDomain: "threadTicks" });
  await waitFor(
    () => page.evaluate(`document.readyState === "complete" || null`),
    20_000,
    "Page did not load"
  );
  await installLongTaskObserver(page);
  const profileId = await configureProfile(popup, protocol);
  const tabId = await popup.evaluate(`
    chrome.tabs.query({}).then((tabs) =>
      tabs.find((tab) => tab.url?.startsWith(${JSON.stringify(server.origin)}))?.id ?? null
    )
  `);
  assert(typeof tabId === "number", "Page tab not found", { tabId });

  if (variant !== "off") {
    await popup.evaluate(
      `chrome.runtime.sendMessage({ kind: "ui.start", tabId: ${tabId}, mode: ${JSON.stringify(mode)}, visualCapture: "none"${
        profileId ? `, profileId: ${JSON.stringify(profileId)}` : ""
      } })`
    );
    await waitFor(
      () =>
        page.evaluate(
          `document.querySelector('[data-webblackbox-indicator="true"]')?.textContent?.includes("REC") || null`
        ),
      25_000,
      "Recording indicator did not appear"
    );
    server.releaseHeld?.();

    // Resources load inside the recording only after a reload (their bodies reach the archive).
    if (process.env.WB_RRWEB_RELOAD_AFTER_START === "1") {
      await page.send("Page.reload");
      await sleep(1_000);
      await waitFor(
        () => page.evaluate(`document.readyState === "complete" || null`),
        30_000,
        "Page did not reload"
      );
      await installLongTaskObserver(page);
    }
  }

  await sleep(1_500);
  const before = await readMetrics(page);
  const clicks = await runSession(page);
  const after = await readMetrics(page);
  const longTasks = await page.evaluate(`window.__wbMeasureLongTasks ?? []`);
  const overhead = {
    taskMs: round((after.TaskDuration - before.TaskDuration) * 1_000),
    scriptMs: round((after.ScriptDuration - before.ScriptDuration) * 1_000),
    layoutMs: round((after.LayoutDuration - before.LayoutDuration) * 1_000),
    styleMs: round((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1_000),
    heapUsedMb: round(after.JSHeapUsedSize / 1_048_576),
    domNodes: after.Nodes,
    longTaskCount: longTasks.length,
    longTaskTotalMs: round(longTasks.reduce((sum, duration) => sum + duration, 0))
  };
  const result = { site, mode, variant, profile: profileChoice, durationMs, overhead, clicks };

  if (variant !== "off") {
    const archive = await stopAndExport(popup, tabId);
    const player = await WebBlackboxPlayer.open(archive.bytes, { passphrase });
    result.archive = { bytes: archive.bytes.byteLength, ...(await analyzeArchive(player)) };
    result.masking = await checkMasking(player);
    result.clickAccuracy = checkClicks(player, clicks, RrwebDomReplay);

    if (checkPlayer && result.archive.rrwebBatches > 0) {
      result.player = await checkInPlayer(browser, archive.path);
    }
  }

  console.log(JSON.stringify(result, null, 2));

  if (process.env.WB_RRWEB_OUT) {
    await writeFile(process.env.WB_RRWEB_OUT, `${JSON.stringify(result, null, 2)}\n`);
  }

  await harness.cleanup();
  process.exit(0);
}

const round = (value) => Math.round(value * 10) / 10;

async function installLongTaskObserver(page) {
  await page.evaluate(`(() => {
    window.__wbMeasureLongTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__wbMeasureLongTasks.push(entry.duration);
    }).observe({ type: "longtask" });
    return true;
  })()`);
}

async function readMetrics(page) {
  const { metrics } = await page.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
}

/**
 * The profile to record with, as the store's default: the built-in Light or Maximum, or
 * "dom-allow" (Lite defaults with the raw DOM and input values, blocked selectors kept).
 */
async function configureProfile(popup, protocol) {
  const profiles =
    profileChoice === "dom-allow"
      ? [
          {
            id: DOM_ALLOW_PROFILE_ID,
            name: "Measure DOM allow",
            base: mode,
            categories: {
              ...protocol.DEFAULT_CAPTURE_POLICY.categories,
              dom: "allow",
              inputs: "allow",
              actions: "allow"
            },
            redaction: protocol.DEFAULT_REDACTION_PROFILE,
            unmaskSelectors: [],
            network: { bodyMimeAllowlist: [], includeUrls: [], excludeUrls: [] },
            pointer: { hover: false, drag: false, wheel: false },
            sampling: {},
            recorder: {},
            sitePolicies: []
          }
        ]
      : [];

  await popup.evaluate(`
    chrome.storage.local.set({
      "webblackbox.profiles": {
        schemaVersion: 2,
        defaultProfileId: ${JSON.stringify(profileIdFor(profileChoice))},
        profiles: ${JSON.stringify(profiles)},
        rules: [],
        extendedCaptureHosts: []
      }
    }).then(() => true)
  `);

  return profileIdFor(profileChoice);
}

function profileIdFor(choice) {
  const id = {
    light: "builtin:lite",
    maximum: "builtin:maximum",
    "dom-allow": DOM_ALLOW_PROFILE_ID
  }[choice];
  assert(id, `Unknown WB_RRWEB_PROFILE "${requestedProfile}" (light, maximum or dom-allow)`);
  return id;
}

/** The element a click at the center of `selector` hits, described as the archive can show it. */
async function clickElement(page, selector) {
  const target = await page.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: "center" });
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return hit ? { x, y, id: hit.id || null, tag: hit.tagName.toLowerCase(), cls: hit.className || null } : null;
  })()`);

  if (!target) {
    return null;
  }

  for (const type of ["mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", {
      type,
      x: target.x,
      y: target.y,
      button: "left",
      clickCount: 1
    });
  }

  return { ...target, at: Date.now() };
}

/** Selectors to click: the heavy SPA's buttons, or visible elements of the realistic site. */
async function clickSelectors(page) {
  if (site === "heavy") {
    const ids = await page.evaluate(`window.__heavy.clickTargets()`);
    return ids.map((id) => `#${id}`);
  }

  return page.evaluate(`(() => {
    const candidates = [...document.querySelectorAll("body *")].filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 20 && rect.height > 10 && rect.top >= 0 && rect.top < innerHeight &&
        element.children.length === 0 && !["SCRIPT", "STYLE", "IMG"].includes(element.tagName);
    });
    return candidates.slice(0, 12).map((element, index) => {
      element.setAttribute("data-measure-click", String(index));
      return '[data-measure-click="' + index + '"]';
    });
  })()`);
}

async function runSession(page) {
  if (site === "realistic") {
    await page.evaluate(`(window.__realistic.run(${durationMs}), true)`);
  }

  const selectors = await clickSelectors(page);
  const clicks = [];
  const startedAt = Date.now();
  let index = 0;

  while (Date.now() - startedAt < durationMs) {
    const selector = selectors[index % selectors.length];
    const click = selector ? await clickElement(page, selector) : null;

    if (click) {
      clicks.push(click);
    }

    if (site === "heavy" && index % 3 === 1) {
      await page.evaluate(`document.querySelector("#notes").focus()`);
      await page.send("Input.insertText", { text: ` ${HEAVY_SECRETS.typed}` });
    }

    index += 1;
    await sleep(Math.max(0, Math.min(clickEveryMs, durationMs - (Date.now() - startedAt))));
  }

  return clicks;
}

async function stopAndExport(popup, tabId) {
  const sid = await popup.evaluate(
    `chrome.runtime.sendMessage({ kind: "ui.request-session-list" }).then((list) => list?.sessions?.find((s) => s.active)?.sid ?? null)`
  );
  assert(typeof sid === "string", "Active session not found");
  await popup.evaluate(`chrome.runtime.sendMessage({ kind: "ui.stop", tabId: ${tabId} })`);
  await sleep(2_000);
  const exported = await popup.evaluate(
    `chrome.runtime.sendMessage({ kind: "ui.export", sid: ${JSON.stringify(sid)}, passphrase: ${JSON.stringify(passphrase)}, saveAs: false })`,
    { timeoutMs: 300_000 }
  );
  assert(exported?.ok === true, "Export failed", exported);
  const path = await harness.waitForDownload();
  const bytes = new Uint8Array(await readFile(path));

  // WB_RRWEB_ARCHIVE_OUT keeps a copy of the archive (fixtures, later analysis).
  if (process.env.WB_RRWEB_ARCHIVE_OUT) {
    await writeFile(process.env.WB_RRWEB_ARCHIVE_OUT, bytes);
  }

  return { path, bytes };
}

const DOM_TYPES = ["dom.snapshot", "dom.mutation.batch", "dom.rrweb.event", "dom.diff"];

async function analyzeArchive(player) {
  const events = player.query();
  const byType = {};

  for (const event of events) {
    const entry = (byType[event.type] ??= { count: 0, jsonBytes: 0 });
    entry.count += 1;
    entry.jsonBytes += JSON.stringify(event).length;
  }

  let domBlobBytes = 0;

  for (const snapshot of events.filter((event) => event.type === "dom.snapshot")) {
    const hash = snapshot.data?.contentHash;
    const blob = typeof hash === "string" ? await player.getBlob(hash) : null;
    domBlobBytes += blob?.bytes.byteLength ?? 0;
  }

  const rrwebBatches = events.filter(
    (event) => event.type === "dom.rrweb.event" && event.data?.schema === "rrweb/v2"
  );
  const rrwebEvents = rrwebBatches.flatMap((event) => event.data.events);

  return {
    eventCount: events.length,
    domJsonBytes: DOM_TYPES.reduce((sum, type) => sum + (byType[type]?.jsonBytes ?? 0), 0),
    domBlobBytes,
    dom: Object.fromEntries(
      DOM_TYPES.filter((type) => byType[type]).map((type) => [type, byType[type]])
    ),
    rrwebBatches: rrwebBatches.length,
    rrwebEvents: rrwebEvents.length,
    rrwebFullSnapshots: rrwebEvents.filter((event) => event.type === 2).length,
    // Pressure mode: pauses, resumes, and a page left to the agent's own DOM capture.
    rrwebRecorderStates: rrwebBatches
      .filter((event) => event.data.recorder)
      .map((event) => event.data.recorder),
    largestRrwebBatchBytes: Math.max(
      0,
      ...rrwebBatches.map((event) => JSON.stringify(event).length)
    ),
    pointerEvents: events.filter((event) => event.type.startsWith("user.")).length
  };
}

async function checkMasking(player) {
  const events = player.query();
  const blobTexts = await Promise.all(
    events
      .filter((event) => typeof event.data?.contentHash === "string")
      .map(async (event) => {
        const blob = await player.getBlob(event.data.contentHash);
        return blob ? new TextDecoder().decode(blob.bytes) : "";
      })
  );
  const domText = (types) =>
    events
      .filter((event) => types.includes(event.type))
      .map((event) => JSON.stringify(event.data))
      .join("\n");
  const rrwebText = domText(["dom.rrweb.event"]);
  const otherText = `${domText(["dom.snapshot", "dom.mutation.batch", "user.input", "user.click"])}\n${blobTexts.join("\n")}`;
  const secrets = site === "heavy" ? HEAVY_SECRETS : {};

  return Object.fromEntries(
    Object.entries(secrets).map(([name, value]) => [
      name,
      { inRrweb: rrwebText.includes(value), inOurDomAndInputs: otherText.includes(value) }
    ])
  );
}

/** Node id → { tag, id, cls } from every full snapshot and added node of the rrweb log. */
function describes(target, expected) {
  if (expected.id) return target.id === expected.id;
  return target.tag === expected.tag && (target.cls ?? null) === (expected.cls || null);
}

/**
 * Click k of the script against our k-th recorded `user.click` (always recorded; scripted and
 * recorded times are not comparable: the page handles a click late while it is busy
 * re-rendering), then the rrweb click recorded with it (player-sdk `RrwebDomReplay.findClick`)
 * resolved through the rebuilt DOM. Clicks inside a pressure-mode gap have no rrweb click.
 */
function checkClicks(player, clicks, RrwebDomReplay) {
  const events = player.query();
  const replay = RrwebDomReplay.fromEvents(events);
  const ourClicks = events
    .filter((event) => event.type === "user.click")
    .sort((left, right) => left.t - right.t);
  let rrwebHits = 0;
  let rrwebFound = 0;
  let inGaps = 0;
  let ourHits = 0;

  clicks.forEach((click, index) => {
    const ours = ourClicks[index];
    const rrwebClick = ours
      ? replay.findClick(ours.mono, { x: ours.data?.x ?? 0, y: ours.data?.y ?? 0 })
      : null;
    const node = rrwebClick ? replay.domAt(rrwebClick.mono)?.tree.get(rrwebClick.nodeId) : null;

    if (rrwebClick) {
      rrwebFound += 1;
    } else if (ours && replay.domAt(ours.mono)?.gap) {
      inGaps += 1;
    }

    rrwebHits +=
      node &&
      describes(
        { tag: node.tagName, id: node.attributes.id ?? null, cls: node.attributes.class ?? null },
        click
      )
        ? 1
        : 0;
    // Our target names are hashed under masking profiles: match the tag and the recorded box.
    const ourTarget = ours?.data?.target;
    const box = ourTarget?.rect;
    ourHits +=
      String(ourTarget?.tag ?? "").toLowerCase() === click.tag &&
      box &&
      click.x >= box.x &&
      click.x <= box.x + box.w &&
      click.y >= box.y &&
      click.y <= box.y + box.h
        ? 1
        : 0;
  });

  return {
    scripted: clicks.length,
    rrwebClicks: rrwebFound,
    rrwebExactTarget: rrwebHits,
    rrwebClicksInGaps: inGaps,
    ourClicks: ourClicks.length,
    ourTargetMatchesBox: ourHits
  };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".map": "application/json"
};

async function startStaticServer(dir) {
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname);
    const file = resolve(dir, `.${path.endsWith("/") ? `${path}index.html` : path}`);

    if (!file.startsWith(dir)) {
      response.writeHead(403).end();
      return;
    }

    try {
      await stat(file);
      response.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream"
      });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  harness.trackServer(server);
  return `http://127.0.0.1:${server.address().port}`;
}

/** Opens the archive in the built Player's DOM replay tab and steps through its clicks. */
async function checkInPlayer(browser, archivePath) {
  const { openEncrypted, testId } = await import(
    pathToFileURL(resolve(repoRoot, "apps/player/scripts/lib/next-e2e.mjs")).href
  );
  const origin = await startStaticServer(resolve(repoRoot, "apps/player/build"));
  const { client } = await harness.openPage(`${origin}/?lang=en`);
  await client.send("Runtime.enable");
  const cspViolations = [];
  await client.send("Log.enable");
  client.on("Log.entryAdded", ({ entry }) => {
    if (/Content Security Policy|Refused to/i.test(entry?.text ?? "")) {
      cspViolations.push(entry.text.slice(0, 200));
    }
  });
  // The replay frame is a separate (sandboxed) document: its console arrives through auto-attach.
  await browser.send("Target.setDiscoverTargets", { discover: true });
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  });
  await waitFor(
    () => client.evaluate(`Boolean(document.querySelector('${testId("archive-input")}')) || null`),
    20_000,
    "Player did not start"
  );
  await openEncrypted(client, archivePath, passphrase);
  await client.evaluate(`location.hash = "#tab=replay"`);
  const status = await waitFor(
    () =>
      client.evaluate(`(() => {
        const node = document.querySelector('${testId("replay-status")}');
        const error = document.querySelector('${testId("replay-error")}');
        if (error) return { error: error.textContent };
        return node ? { events: Number(node.dataset.events), text: node.textContent } : null;
      })()`),
    60_000,
    "The DOM replay did not load (frame never reported loaded)"
  );
  const clickCount = await client.evaluate(
    `document.querySelectorAll('${testId("replay-click")}').length`
  );
  const highlights = [];

  for (let index = 0; index < Math.min(clickCount, 8); index += 1) {
    await client.evaluate(
      `document.querySelectorAll('${testId("replay-click")}')[${index}].click()`
    );
    const highlight = await waitFor(
      () =>
        client.evaluate(`(() => {
          const node = document.querySelector('${testId("replay-highlight")}');
          const status = document.querySelector('${testId("replay-status")}');
          return node ? { found: node.dataset.found === "true", text: node.textContent, seekMs: Number(status?.dataset.seekMs || NaN) } : null;
        })()`),
      15_000,
      "No highlight for a click"
    ).catch(() => ({ found: false, text: "timeout", seekMs: null }));
    highlights.push(highlight);
    await sleep(300);
  }

  if (process.env.WB_RRWEB_SCREENSHOT) {
    const { data } = await client.send("Page.captureScreenshot", { format: "png" });
    await writeFile(process.env.WB_RRWEB_SCREENSHOT, Buffer.from(data, "base64"));
  }

  // Seek from the start to the end of the session (worst case: everything since the snapshot).
  const seekEnd = await client.evaluate(`(async () => {
    const slider = document.querySelector('[role="slider"]');
    return slider ? slider.getAttribute("aria-valuetext") : null;
  })()`);

  return { status, clickCount, highlights, cspViolations, timelineAt: seekEnd };
}
