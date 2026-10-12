// Archive data checks for the extension e2e, on the built player-sdk (no Player DOM): the
// archive is opened (and decrypted) in Node, so the checks never depend on a UI layout or the
// playhead, and they also run on encrypted exports.

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const playerSdkModules = new Map();
// The player-sdk module each opened archive came from (for its report formatter).
const sdkByPlayer = new WeakMap();

function loadPlayerSdk(playerSdkEntry) {
  if (!playerSdkModules.has(playerSdkEntry)) {
    playerSdkModules.set(playerSdkEntry, import(pathToFileURL(playerSdkEntry).href));
  }

  return playerSdkModules.get(playerSdkEntry);
}

/** Opens an exported archive with the built player-sdk. */
export async function openArchive({ archivePath, passphrase, playerSdkEntry }) {
  const sdk = await loadPlayerSdk(playerSdkEntry);
  const player = await sdk.WebBlackboxPlayer.open(new Uint8Array(await readFile(archivePath)), {
    passphrase: passphrase || undefined
  });
  sdkByPlayer.set(player, sdk);
  return player;
}

/** Export truncations a default (whole-session) export must never record. */
const UNEXPECTED_TRUNCATIONS = new Set(["recent-window", "size-limit", "chunk-unreadable"]);

/**
 * The archive has events, network rows (one matching `urlIncludes`) and every listed type, and
 * records what its export kept: the whole session (only visuals the export did not ask for may
 * be left out).
 */
export function checkArchiveBasics(player, { requiredEventTypes = [], urlIncludes } = {}) {
  const events = player.query({});
  const waterfall = player.getNetworkWaterfall();
  const types = new Set(events.map((event) => event.type));
  const missingEventTypes = requiredEventTypes.filter((type) => !types.has(type));
  const hasUrl = urlIncludes ? waterfall.some((entry) => entry.url.includes(urlIncludes)) : true;
  const completeness = player.archive.manifest.completeness ?? null;
  const unexpectedTruncations = (completeness?.truncations ?? []).filter((row) =>
    UNEXPECTED_TRUNCATIONS.has(row.reason)
  );

  return {
    ok:
      events.length > 0 &&
      waterfall.length > 0 &&
      missingEventTypes.length === 0 &&
      hasUrl &&
      completeness !== null &&
      unexpectedTruncations.length === 0,
    eventCount: events.length,
    waterfallCount: waterfall.length,
    missingEventTypes,
    hasUrl,
    completeness,
    unexpectedTruncations
  };
}

/** Real-world evidence: page markers, URLs and event types the scenario produced. */
export function checkArchiveEvidence(player, evidence) {
  const events = player.query({});
  const eventTexts = events.map((event) => `${event.type} ${safeStringify(event.data)}`);
  const missingMarkers = (evidence.markers ?? []).filter(
    (marker) => !eventTexts.some((text) => text.includes(marker))
  );
  const missingUrls = (evidence.urls ?? []).filter(
    (url) => !eventTexts.some((text) => text.includes(url))
  );
  const missingEventTypes = (evidence.eventTypes ?? []).filter(
    (type) => !events.some((event) => event.type === type)
  );

  return {
    ok: missingMarkers.length === 0 && missingUrls.length === 0 && missingEventTypes.length === 0,
    eventCount: events.length,
    missingMarkers,
    missingUrls,
    missingEventTypes
  };
}

/** Screenshots: present with readable image blobs, or absent when the run disabled them. */
export async function checkScreenshots(player, { expected }) {
  const shots = player.query({}).filter((event) => event.type === "screen.screenshot");

  if (!expected) {
    return { ok: shots.length === 0, screenshots: shots.length };
  }

  let readable = 0;

  for (const shot of shots) {
    const hash = shot.data?.shotId ?? shot.ref?.shot;
    const blob = typeof hash === "string" ? await player.getBlob(hash) : null;
    readable += blob && blob.bytes.byteLength > 0 ? 1 : 0;
  }

  return {
    ok: shots.length > 0 && readable === shots.length,
    screenshots: shots.length,
    readable
  };
}

/** Tab video: start, chunks and end, with every referenced chunk stored. */
export async function checkScreenRecording(player) {
  const events = player.query({});
  const ofType = (type) => events.filter((event) => event.type === type);
  const chunks = ofType("screen.recording.chunk");
  const endWithChunks = ofType("screen.recording.end").find(
    (event) => Array.isArray(event.data?.chunks) && event.data.chunks.length > 0
  );
  const chunkIds = new Set(
    [...chunks.map((event) => event.data?.chunkId), ...(endWithChunks?.data?.chunks ?? [])].filter(
      (value) => typeof value === "string" && value.length > 0
    )
  );
  const missingChunkBlobs = [];

  for (const chunkId of chunkIds) {
    if (!(await player.getBlob(chunkId))) {
      missingChunkBlobs.push(chunkId);
    }
  }

  return {
    ok:
      ofType("screen.recording.start").length > 0 &&
      chunks.length > 0 &&
      Boolean(endWithChunks) &&
      missingChunkBlobs.length === 0,
    chunkEvents: chunks.length,
    endChunkCount: endWithChunks?.data?.chunks?.length ?? 0,
    referencedChunks: chunkIds.size,
    missingChunkBlobs
  };
}

/** At least one response body of a matching request is stored and readable as text. */
export async function checkResponseBodyPreview(player, { urlIncludes = "/api/" } = {}) {
  const candidates = player
    .getNetworkWaterfall()
    .filter((entry) => entry.responseBodyHash && entry.url.includes(urlIncludes));

  for (const entry of candidates) {
    const blob = await player.getBlob(entry.responseBodyHash);
    const text = blob ? new TextDecoder().decode(blob.bytes) : "";

    if (text.length > 0) {
      return { ok: true, url: entry.url, chars: text.length, candidates: candidates.length };
    }
  }

  return { ok: false, candidates: candidates.length };
}

const COMPLETENESS_BOUNDS = [
  [
    "maxMissingResponseBodies",
    "max",
    "silently missing response bodies",
    (r) => r.network.responseBodies.missing
  ],
  [
    "maxMissingRequestBodies",
    "max",
    "silently missing request bodies",
    (r) => r.network.requestBodies.missing
  ],
  [
    "minResponseBodies",
    "min",
    "captured response bodies",
    (r) => r.network.responseBodies.captured
  ],
  ["minRequestBodies", "min", "captured request bodies", (r) => r.network.requestBodies.captured],
  [
    "minCutResponseBodies",
    "min",
    "response bodies kept cut at the limit",
    (r) => r.network.responseBodies.truncated
  ],
  ["maxInternalRequests", "max", "extension/internal requests", (r) => r.network.internalRequests],
  ["minRequests", "min", "requests", (r) => r.network.requests],
  ["minDomCoveragePercent", "min", "DOM coverage %", (r) => Math.round(r.dom.coverage * 100)],
  ["maxDomGapMs", "max", "longest DOM gap ms", (r) => Math.round(r.dom.longestGapMs)],
  ["minWsFrames", "min", "WebSocket frames", (r) => r.realtime.wsFrames],
  [
    "maxCutWsFrames",
    "max",
    "cut WebSocket frames",
    (r) => r.realtime.truncatedFrames + r.realtime.incompleteFrames
  ],
  ["minConsoleEntries", "min", "console entries", (r) => r.console.entries],
  ["maxCutConsoleEntries", "max", "cut console entries", (r) => r.console.truncated],
  ["minWithStack", "min", "console/errors with a stack", (r) => r.console.withStack],
  ["minVitals", "min", "perf vitals", (r) => r.perf.vitals],
  [
    "minSvgBodies",
    "min",
    "captured SVG bodies",
    (r) => r.network.responseBodies.byMime["image/svg+xml"]?.captured ?? 0
  ],
  [
    "minDataUrls",
    "min",
    "data: URL responses (body in the URL)",
    (r) => r.network.responseBodies.dataUrls ?? 0
  ],
  ["minLongTasks", "min", "perf long tasks", (r) => r.perf.longTasks],
  ["minCookieValues", "min", "cookie values", (r) => r.storage.cookieValues],
  ["minLocalValues", "min", "localStorage values", (r) => r.storage.localValues],
  ["minIdbRecords", "min", "IndexedDB records", (r) => r.storage.idbRecords]
];

/**
 * Checks the player-sdk completeness report against expectations; every key is optional
 * (`max*` upper bounds, `min*` lower bounds, `minSkipReasons` / `maxSkipReasons` per reason
 * over request and response bodies together).
 */
export function checkCompleteness(player, expectations) {
  const report = player.getCaptureCompleteness();
  const failures = [];
  const check = (label, actual, limit, kind) => {
    if (limit !== undefined && (kind === "max" ? actual > limit : actual < limit)) {
      failures.push(`${label}: ${actual} (${kind} ${limit})`);
    }
  };

  for (const [key, kind, label, read] of COMPLETENESS_BOUNDS) {
    check(label, read(report), expectations[key], kind);
  }

  const skipped = (reason) =>
    (report.network.responseBodies.skipReasons[reason] ?? 0) +
    (report.network.requestBodies.skipReasons[reason] ?? 0);

  for (const [reason, limit] of Object.entries(expectations.maxSkipReasons ?? {})) {
    check(`bodies skipped as ${reason}`, skipped(reason), limit, "max");
  }

  for (const [reason, minimum] of Object.entries(expectations.minSkipReasons ?? {})) {
    check(`bodies skipped as ${reason}`, skipped(reason), minimum, "min");
  }

  const format = sdkByPlayer.get(player)?.formatCaptureCompletenessReport;
  return { ok: failures.length === 0, failures, report, lines: format ? format(report) : [] };
}

const A11Y_ERROR_EVENT_TYPES = new Set([
  "console.entry",
  "error.exception",
  "error.unhandledrejection"
]);

/**
 * Accessibility snapshots: one linked to the scenario's click that shows what the click caused
 * (`alertText`), one linked to its error, and the last state at Stop; all within their budget.
 */
export function checkA11ySnapshots(player, { alertText }) {
  const events = player.query({});
  const byId = new Map(events.map((event) => [event.id, event]));
  const snapshots = events.filter((event) => event.type === "dom.a11y.snapshot");
  const linkedType = (snapshot) => byId.get(snapshot.data?.trigger?.eventId)?.type;
  const action = snapshots.find(
    (snapshot) =>
      snapshot.data?.trigger?.kind === "action" &&
      linkedType(snapshot) === "user.click" &&
      String(snapshot.data?.tree ?? "").includes(alertText)
  );
  const error = snapshots.find(
    (snapshot) =>
      snapshot.data?.trigger?.kind === "error" && A11Y_ERROR_EVENT_TYPES.has(linkedType(snapshot))
  );
  const stop = snapshots.find((snapshot) => snapshot.data?.trigger?.kind === "stop");
  const durations = snapshots.map((snapshot) => Number(snapshot.data?.durationMs ?? 0));

  return {
    ok: Boolean(action && error && stop),
    snapshots: snapshots.length,
    triggers: snapshots.map(
      (snapshot) => `${snapshot.data?.trigger?.kind}:${snapshot.data?.trigger?.rawType ?? ""}`
    ),
    action: action ? { id: action.id, linked: action.data.trigger.eventId } : null,
    error: error ? { id: error.id, linked: linkedType(error) } : null,
    stop: Boolean(stop),
    maxDurationMs: Math.max(0, ...durations),
    maxTreeChars: Math.max(
      0,
      ...snapshots.map((snapshot) => String(snapshot.data?.tree ?? "").length)
    ),
    droppedTriggers: snapshots.reduce(
      (sum, snapshot) => sum + Number(snapshot.data?.droppedTriggers ?? 0),
      0
    )
  };
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
