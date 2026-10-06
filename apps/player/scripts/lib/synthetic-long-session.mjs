// A long synthetic recording for the Player bench (`pnpm --filter @webblackbox/player bench`):
// about ten minutes of a busy single-page app — clicks with their action spans, fetch/XHR with
// bodies, failures, a SignalR WebSocket, console logs and errors, storage writes, hash routes and
// screenshots — in the shapes of `synthetic-session.mjs`. Deterministic for a given seed.
import JSZip from "jszip";

import { createCanvas } from "./png.mjs";
import { encodeEventChunk, sha256Hex } from "./synthetic-session.mjs";

export const LONG_SESSION_ORIGIN = "https://app.example.test";
export const LONG_SESSION_DEFAULTS = Object.freeze({
  durationMs: 600_000,
  events: 60_000,
  seed: 20_261_006
});

const SESSION_ID = "S-1790000000000-long-bench";
const BASE_T = 1_790_000_000_000;
const MAIN_FRAME = "F0MAINFRAME0000000000000000000000";
const VIEWPORT = { w: 1440, h: 900, dpr: 1, scrollX: 0, scrollY: 0 };
const RS = "\u001e";
/** About the pipeline's chunk size (CLAUDE.md: ~512 KB NDJSON chunks). */
const CHUNK_BYTES = 512 * 1024;
/** Distinct response bodies; real sessions repeat the same payloads (blobs are deduplicated). */
const BODY_POOL_SIZE = 96;
const ROUTES = ["#/lobby", "#/live/64", "#/live/65", "#/history", "#/profile", "#/settings"];
const ENDPOINTS = [
  "/gw/bff/tournaments/api/v1.0/group/2/active",
  "/gw/bff/users/api/v1.0/casino-user",
  "/gw/bff/ladder/api/v1.0/state",
  "/gw/bff/games/api/v2.0/list",
  "/gw/bff/chats/api/v1.0/rooms",
  "/gw/bff/wallet/api/v1.0/balance",
  "/assets/resources/config.json",
  "/gw/bff/promo/api/v1.0/banners"
];
const CONSOLE_LINES = [
  "isHiddenTestFeature: false",
  "[signalr] heartbeat",
  "render lobby grid",
  "wallet balance refreshed",
  "route changed"
];
/** Average events one action cycle adds (see `addCycle`), used to size the session. */
const EVENTS_PER_CYCLE = 100;

/** mulberry32: a small seeded PRNG, so every run builds the same archive. */
function createRandom(seed) {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function drawFrame(hue) {
  const canvas = createCanvas(480, 300, "#151a24");
  canvas.fillRect(0, 0, 480, 28, "#1d2433");

  for (let column = 0; column < 4; column += 1) {
    canvas.fillRect(20 + column * 115, 60, 100, 80, hue);
    canvas.fillRect(20 + column * 115, 160, 100, 80, "#2f4a6b");
  }

  return canvas.toPng();
}

/**
 * Events (sorted by mono, epoch-ms scale), blobs and manifest of a long session.
 * @param {{ durationMs?: number; events?: number; seed?: number }} [options]
 */
export function buildLongSyntheticSession(options = {}) {
  const durationMs = options.durationMs ?? LONG_SESSION_DEFAULTS.durationMs;
  const targetEvents = options.events ?? LONG_SESSION_DEFAULTS.events;
  const random = createRandom(options.seed ?? LONG_SESSION_DEFAULTS.seed);
  const pick = (items) => items[Math.floor(random() * items.length)];
  const events = [];
  const blobs = new Map();
  let sequence = 0;
  let requestSequence = 0;

  const add = (offsetMs, type, data, extra = {}) => {
    sequence += 1;
    const at = BASE_T + Math.min(durationMs, Math.max(0, Math.round(offsetMs * 100) / 100));
    events.push({
      v: 1,
      sid: SESSION_ID,
      tab: 7,
      t: at,
      mono: at,
      type,
      id: `E-${String(sequence).padStart(8, "0")}`,
      ...extra,
      data
    });
  };

  const addBlob = (mime, bytes) => {
    const hash = sha256Hex(bytes);

    if (!blobs.has(hash)) {
      blobs.set(hash, { hash, mime, bytes });
    }

    return hash;
  };

  const bodies = Array.from({ length: BODY_POOL_SIZE }, (_, index) =>
    new TextEncoder().encode(
      JSON.stringify({
        id: index,
        items: Array.from({ length: 4 + (index % 12) }, (__, item) => ({
          id: index * 100 + item,
          title: `Table ${index}-${item}`,
          players: (index * 7 + item * 3) % 9
        }))
      })
    )
  );
  const frames = [drawFrame("#4a3a6b"), drawFrame("#2f5b4a"), drawFrame("#6b4a2f")];

  const request = (offsetMs, latencyMs, { act, thirdParty = false, failed = false, status }) => {
    requestSequence += 1;
    const reqId = `90080.${requestSequence}`;
    const ref = { req: reqId, ...(act ? { act } : {}) };
    const url = thirdParty
      ? `https://tracker.example.net/tag/${requestSequence}`
      : `${LONG_SESSION_ORIGIN}${pick(ENDPOINTS)}?r=${requestSequence}`;
    const type = thirdParty ? "Script" : "XHR";
    add(
      offsetMs,
      "network.request",
      {
        requestId: reqId,
        type,
        initiator: { type: "script" },
        request: { url, method: "GET", headers: { accept: "application/json, text/plain, */*" } }
      },
      { ref }
    );

    if (failed) {
      add(
        offsetMs + latencyMs,
        "network.failed",
        { requestId: reqId, type, errorText: "net::ERR_CONNECTION_RESET", canceled: false },
        { ref }
      );
      return;
    }

    const body = thirdParty ? null : pick(bodies);
    add(
      offsetMs + latencyMs * 0.9,
      "network.response",
      {
        requestId: reqId,
        type,
        response: {
          url,
          status: status ?? 200,
          statusText: status === 401 ? "Unauthorized" : "OK",
          headers: { "content-type": "application/json" },
          mimeType: "application/json",
          protocol: "h2",
          encodedDataLength: body?.byteLength ?? 320
        }
      },
      { ref }
    );
    add(
      offsetMs + latencyMs,
      "network.finished",
      { requestId: reqId, encodedDataLength: body?.byteLength ?? 320 },
      { ref }
    );

    if (body) {
      add(
        offsetMs + latencyMs,
        "network.body",
        {
          reqId,
          contentHash: addBlob("application/json", body),
          mimeType: "application/json",
          size: body.byteLength,
          sampledSize: body.byteLength,
          redacted: false,
          truncated: false
        },
        { ref }
      );
    }
  };

  const socketReqId = "90080.ws.1";
  const frame = (offsetMs, direction, payload) =>
    add(
      offsetMs,
      "network.ws.frame",
      {
        requestId: socketReqId,
        timestamp: offsetMs / 1_000,
        direction,
        frame: {
          opcode: 1,
          masked: direction === "sent",
          payloadLength: payload.length,
          payloadPreview: payload
        }
      },
      { ref: { req: socketReqId } }
    );

  const consoleEntry = (offsetMs, level, text) =>
    add(offsetMs, "console.entry", {
      source: "cdp.runtime",
      level,
      method: level,
      text,
      args: [text],
      ...(level === "error"
        ? { stackTop: `ensureUser @ ${LONG_SESSION_ORIGIN}/app.js:57:12` }
        : {}),
      timestamp: BASE_T + offsetMs
    });

  /** One user action and what follows it (about EVENTS_PER_CYCLE events). */
  const addCycle = (index, startMs, spanMs) => {
    const act = `A-${String(index + 1).padStart(6, "0")}`;
    const x = 200 + Math.floor(random() * 1_000);
    const y = 150 + Math.floor(random() * 600);
    const routeChange = index % 8 === 0;
    const route = ROUTES[Math.floor(index / 8) % ROUTES.length];
    const at = (fraction) => startMs + spanMs * fraction;

    for (let step = 0; step < 8; step += 1) {
      add(at(step * 0.01), "user.mousemove", {
        x: x - 40 + step * 5,
        y: y - 20 + step * 2,
        target: { tag: "DIV", classTokens: ["page"] }
      });
    }

    add(
      at(0.1),
      "user.click",
      {
        x,
        y,
        pageX: x,
        pageY: y,
        viewport: VIEWPORT,
        button: 0,
        altKey: false,
        ctrlKey: false,
        shiftKey: false,
        metaKey: false,
        target: {
          tag: "BUTTON",
          classTokens: ["card"],
          readable: { text: `Table ${index % 50}`, css: `#lobbyGame_${index % 50} img` },
          rect: { x: x - 60, y: y - 40, w: 120, h: 80 }
        },
        ...(routeChange
          ? { routeContext: { url: `${LONG_SESSION_ORIGIN}/${route}`, source: "history" } }
          : {})
      },
      { ref: { act } }
    );

    if (routeChange) {
      add(at(0.12), "nav.hash", {
        frameId: MAIN_FRAME,
        navigationType: "historyApi",
        url: `${LONG_SESSION_ORIGIN}/${route}`
      });
    }

    for (let item = 0; item < 10; item += 1) {
      const unauthorized = index % 25 === 3 && item === 1;
      request(at(0.11 + item * 0.03), 40 + random() * 300, {
        act,
        failed: !unauthorized && random() < 0.04,
        ...(unauthorized ? { status: 401 } : {})
      });
    }

    for (let item = 0; item < 5; item += 1) {
      request(at(0.45 + item * 0.08), 20 + random() * 120, {
        thirdParty: item === 0,
        failed: item === 0 && random() < 0.3
      });
    }

    for (let item = 0; item < 30; item += 1) {
      const sent = item % 6 === 0;
      frame(
        at(0.05 + item * 0.031),
        sent ? "sent" : "received",
        sent
          ? `{"type":1,"target":"Ping","arguments":[${index}],"invocationId":"${item}"}${RS}`
          : `{"type":1,"target":"TableUpdated","arguments":[{"id":${index % 50},"seats":${item % 9}}]}${RS}`
      );
    }

    for (let item = 0; item < 5; item += 1) {
      consoleEntry(at(0.2 + item * 0.15), item === 4 ? "warn" : "log", pick(CONSOLE_LINES));
    }

    if (index % 5 === 0) {
      consoleEntry(at(0.3), "error", "AuthError: casino-user request rejected (401 invalid_token)");
    }

    add(at(0.6), "storage.local.op", {
      op: "setItem",
      redacted: false,
      key: `lobbyState.${index % 20}`,
      valueLength: 24,
      value: `{"open":${index % 50},"v":${index}}`
    });
    add(at(0.62), "storage.session.op", {
      op: "setItem",
      redacted: false,
      key: "lastRoute",
      valueLength: route.length,
      value: route
    });

    if (index % 10 === 0) {
      add(at(0.7), "perf.longtask", {
        name: "self",
        startTime: at(0.7),
        duration: 60 + random() * 200
      });
    }

    if (index % 5 === 0) {
      const shot = addBlob("image/png", frames[index % frames.length]);
      add(
        at(0.9),
        "screen.screenshot",
        {
          shotId: shot,
          format: "png",
          w: 480,
          h: 300,
          size: frames[index % frames.length].byteLength,
          reason: "interval",
          viewport: { width: 1440, height: 900, dpr: 1 },
          pointer: { x, y, t: BASE_T + at(0.9), mono: BASE_T + at(0.9) }
        },
        { ref: { shot } }
      );
    }
  };

  add(0, "meta.config", { mode: "full", ringBufferMinutes: 10, freezeOnError: false });
  add(10, "network.ws.open", {
    requestId: socketReqId,
    url: `wss://app.example.test/proxy-live/hubs?access_token=eyJhbGci.redacted`,
    initiator: { type: "script" }
  });
  frame(20, "sent", `{"protocol":"json","version":1}${RS}`);
  frame(40, "received", `{}${RS}`);
  add(50, "storage.local.snapshot", {
    reason: "start",
    truncated: false,
    count: 1,
    mode: "full",
    redacted: false,
    entries: [{ key: "lang", valueLength: 2, value: "en" }]
  });
  add(60, "perf.vitals", { ttfb: 182, lcp: 2_480 });

  const cycles = Math.max(1, Math.round(targetEvents / EVENTS_PER_CYCLE));
  const spanMs = (durationMs - 200) / cycles;

  for (let index = 0; index < cycles; index += 1) {
    addCycle(index, 100 + index * spanMs, spanMs);
  }

  add(durationMs, "user.visibility", { state: "hidden" });
  events.sort((left, right) => left.mono - right.mono || left.id.localeCompare(right.id));

  return {
    events,
    blobs: [...blobs.values()],
    manifest: {
      protocolVersion: 1,
      createdAt: new Date(BASE_T).toISOString(),
      mode: "full",
      site: { origin: LONG_SESSION_ORIGIN, title: "Long synthetic session" },
      chunkCodec: "none",
      redactionProfile: {
        redactHeaders: ["authorization", "cookie"],
        redactCookieNames: [],
        redactBodyPatterns: [],
        blockedSelectors: [],
        hashSensitiveValues: true
      },
      stats: {
        eventCount: events.length,
        chunkCount: 0,
        blobCount: blobs.size,
        durationMs
      }
    }
  };
}

/** Splits the events into NDJSON chunks of about CHUNK_BYTES, like the pipeline does. */
function chunkEvents(events) {
  const chunks = [];
  let current = [];
  let bytes = 0;

  for (const event of events) {
    const size = JSON.stringify(event).length + 1;

    if (current.length > 0 && bytes + size > CHUNK_BYTES) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }

    current.push(event);
    bytes += size;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

/**
 * Unencrypted archive bytes of a long session, with the time index split per chunk.
 * @param {ReturnType<typeof buildLongSyntheticSession>} [session]
 */
export async function createLongPlainArchive(session = buildLongSyntheticSession()) {
  const zip = new JSZip();
  const chunks = chunkEvents(session.events);
  const timeIndex = [];
  const requestIndex = new Map();

  for (const [index, chunk] of chunks.entries()) {
    const chunkId = `C-${String(index + 1).padStart(6, "0")}`;
    const bytes = encodeEventChunk(chunk);
    const first = chunk[0];
    const last = chunk[chunk.length - 1];

    zip.file(`events/${chunkId}.ndjson`, Buffer.from(bytes));
    timeIndex.push({
      chunkId,
      seq: index + 1,
      tStart: first.t,
      tEnd: last.t,
      monoStart: first.mono,
      monoEnd: last.mono,
      eventCount: chunk.length,
      byteLength: bytes.byteLength,
      codec: "none",
      sha256: sha256Hex(bytes)
    });
  }

  for (const event of session.events) {
    const reqId = event.ref?.req;

    if (reqId) {
      const ids = requestIndex.get(reqId) ?? [];
      ids.push(event.id);
      requestIndex.set(reqId, ids);
    }
  }

  zip.file("index/time.json", JSON.stringify(timeIndex));
  zip.file(
    "index/req.json",
    JSON.stringify([...requestIndex].map(([reqId, eventIds]) => ({ reqId, eventIds })))
  );
  zip.file("index/inv.json", JSON.stringify([]));

  for (const blob of session.blobs) {
    const extension = blob.mime === "image/png" ? "png" : "json";
    zip.file(`blobs/sha256-${blob.hash}.${extension}`, Buffer.from(blob.bytes));
  }

  zip.file(
    "manifest.json",
    JSON.stringify({
      ...session.manifest,
      stats: { ...session.manifest.stats, chunkCount: chunks.length }
    })
  );

  const files = {};

  for (const path of Object.keys(zip.files).sort()) {
    const file = zip.file(path);

    if (file) {
      files[path] = sha256Hex(await file.async("uint8array"));
    }
  }

  zip.file(
    "integrity/hashes.json",
    JSON.stringify({ manifestSha256: files["manifest.json"] ?? "", files })
  );

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
