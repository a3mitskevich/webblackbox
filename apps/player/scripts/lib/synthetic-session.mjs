// Synthetic session shaped like a real Full-capture archive (anonymized hosts): an error page and
// reload, hash routes, a lobby click that triggers 401s on /gw/bff/*, SignalR WebSockets, console
// errors, third-party failures, other tabs of the site and three drawn screenshots.
// Used by the player unit tests (plain archive) and by e2e-player-next (encrypted archive).
import { createHash } from "node:crypto";

import JSZip from "jszip";

import { createCanvas } from "./png.mjs";
import { addSyntheticNetworkEvents } from "./synthetic-network.mjs";

export const SYNTHETIC_ORIGIN = "https://app.example.test";
export const SYNTHETIC_PASSPHRASE = "player-next-e2e";
export const SYNTHETIC_SESSION_ID = "S-1790000000000-synthetic";
export const SYNTHETIC_DURATION_MS = 17_800;

const APP_URL = `${SYNTHETIC_ORIGIN}/?lng=en&clientId=1001`;
const BASE_T = 1_790_000_000_000;
const MAIN_FRAME = "F0MAINFRAME0000000000000000000000";
const CHILD_FRAME = "D0CHILDFRAME000000000000000000000";
const VIEWPORT = { w: 960, h: 540, dpr: 1, scrollX: 0, scrollY: 0 };
const RS = "\u001e";

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function drawErrorPage() {
  const canvas = createCanvas(960, 540, "#f4f5f7");
  canvas.fillRect(0, 0, 960, 56, "#1d2433");
  canvas.fillRect(32, 20, 120, 16, "#3a4561");
  canvas.fillRect(330, 170, 300, 26, "#c92a2a");
  canvas.fillRect(300, 214, 360, 12, "#c9d0d8");
  canvas.fillRect(340, 236, 280, 12, "#c9d0d8");
  canvas.fillRect(400, 290, 160, 44, "#2b59e0");
  return canvas.toPng();
}

function drawLobby() {
  const canvas = createCanvas(960, 540, "#151a24");
  const hues = ["#2f4a6b", "#2f5b4a", "#4a3a6b", "#6b4a2f", "#6b2f4a"];
  canvas.fillRect(0, 0, 960, 56, "#1d2433");
  canvas.fillRect(32, 20, 120, 16, "#3a4561");

  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      const x = 60 + column * 172;
      const y = 96 + row * 140;
      canvas.fillRect(x, y, 156, 120, hues[(row + column) % hues.length]);
      canvas.fillRect(x + 12, y + 92, 86, 10, "#9aa6b2");
    }
  }

  return canvas.toPng();
}

function drawGame() {
  const canvas = createCanvas(960, 540, "#0f2a22");
  canvas.fillRect(0, 0, 960, 44, "#0b1d17");
  canvas.fillCircle(480, 760, 520, "#14513c");

  for (let index = 0; index < 6; index += 1) {
    canvas.fillCircle(250 + index * 92, 470, 26, "#1f4a3b");
  }

  canvas.fillRect(320, 180, 320, 150, "#f4f6f8");
  canvas.fillRect(370, 204, 220, 14, "#c9d0d8");
  canvas.fillRect(350, 232, 260, 10, "#dde2e7");
  canvas.fillRect(410, 272, 140, 36, "#ffffff");
  canvas.fillRect(410, 306, 140, 2, "#9aa6b2");
  return canvas.toPng();
}

/**
 * Events (sorted by mono; mono is on an epoch-ms scale like real CDP archives), blobs and manifest
 * of the synthetic session.
 */
export function buildSyntheticSession() {
  const events = [];
  const blobs = [];
  let sequence = 0;

  const add = (offsetMs, type, data, extra = {}) => {
    sequence += 1;
    const id = `E-${String(sequence).padStart(8, "0")}`;
    events.push({
      v: 1,
      sid: SYNTHETIC_SESSION_ID,
      tab: 7,
      t: BASE_T + offsetMs,
      mono: BASE_T + offsetMs,
      type,
      id,
      ...extra,
      data
    });
    return id;
  };

  const addBlob = (mime, bytes) => {
    const hash = sha256Hex(bytes);

    if (!blobs.some((blob) => blob.hash === hash)) {
      blobs.push({ hash, mime, bytes });
    }

    return hash;
  };

  const route = (url) => ({ routeContext: { url, source: "history" } });

  const request = (offsetMs, durationMs, options) => {
    const ref = { req: options.reqId, ...(options.act ? { act: options.act } : {}) };
    const type = options.type ?? "XHR";
    add(
      offsetMs,
      "network.request",
      {
        requestId: options.reqId,
        type,
        initiator: { type: "script" },
        request: {
          url: options.url,
          method: options.method ?? "GET",
          headers: { accept: "application/json, text/plain, */*" }
        }
      },
      { ref }
    );

    if (options.errorText) {
      add(
        offsetMs + durationMs,
        "network.failed",
        { requestId: options.reqId, type, errorText: options.errorText, canceled: false },
        { ref }
      );
      return;
    }

    const body = options.body ? new TextEncoder().encode(options.body) : null;
    add(
      offsetMs + durationMs * 0.9,
      "network.response",
      {
        requestId: options.reqId,
        type,
        response: {
          url: options.url,
          status: options.status ?? 200,
          statusText: options.statusText ?? "OK",
          headers: {
            "content-type": options.mimeType ?? "application/json",
            ...(options.responseHeaders ?? {})
          },
          mimeType: options.mimeType ?? "application/json",
          protocol: "h2",
          encodedDataLength: body?.byteLength ?? 320
        }
      },
      { ref }
    );
    add(
      offsetMs + durationMs,
      "network.finished",
      { requestId: options.reqId, encodedDataLength: body?.byteLength ?? 320 },
      { ref }
    );

    if (body) {
      const hash = addBlob(options.mimeType ?? "application/json", body);
      add(
        offsetMs + durationMs,
        "network.body",
        {
          reqId: options.reqId,
          contentHash: hash,
          mimeType: options.mimeType ?? "application/json",
          size: body.byteLength,
          sampledSize: body.byteLength,
          redacted: false,
          truncated: false
        },
        { ref }
      );
    }
  };

  const pointer = (offsetMs, x, y) =>
    add(offsetMs, "user.mousemove", { x, y, target: { tag: "DIV", classTokens: ["page"] } });

  const click = (offsetMs, act, x, y, text, css, url) =>
    add(
      offsetMs,
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
          classTokens: ["btn"],
          readable: { text, css },
          rect: { x: x - 60, y: y - 18, w: 120, h: 36 }
        },
        ...(url ? route(url) : {})
      },
      { ref: { act } }
    );

  const screenshot = (offsetMs, bytes, reason, x, y) => {
    const hash = addBlob("image/png", bytes);
    add(
      offsetMs,
      "screen.screenshot",
      {
        shotId: hash,
        format: "png",
        w: 960,
        h: 540,
        size: bytes.byteLength,
        reason,
        viewport: { width: 960, height: 540, dpr: 1 },
        pointer: { x, y, t: BASE_T + offsetMs, mono: BASE_T + offsetMs }
      },
      { ref: { shot: hash } }
    );
  };

  const consoleError = (offsetMs, text, extra = {}) =>
    add(offsetMs, "console.entry", {
      source: extra.source ?? "console-api",
      level: "error",
      method: "error",
      text,
      args: [text],
      ...(extra.stackTop ? { stackTop: extra.stackTop } : {}),
      ...(extra.url ? { url: extra.url } : {}),
      ...(extra.networkRequestId ? { networkRequestId: extra.networkRequestId } : {}),
      timestamp: BASE_T + offsetMs
    });

  const socket = (offsetMs, reqId, path, frames) => {
    const url = `wss://app.example.test${path}?access_token=eyJhbGci.redacted`;
    add(
      offsetMs,
      "network.ws.open",
      { requestId: reqId, url, initiator: { type: "script" } },
      { ref: { req: reqId } }
    );

    for (const [delayMs, direction, payload, payloadLength] of frames) {
      add(
        offsetMs + delayMs,
        "network.ws.frame",
        {
          requestId: reqId,
          timestamp: (offsetMs + delayMs) / 1_000,
          direction,
          frame: {
            opcode: 1,
            masked: direction === "sent",
            payloadLength: payloadLength ?? payload.length,
            payloadPreview: payload
          }
        },
        { ref: { req: reqId } }
      );
    }
  };

  const errorPage = drawErrorPage();
  const lobby = drawLobby();
  const game = drawGame();

  add(0, "meta.config", { mode: "full", ringBufferMinutes: 10, freezeOnError: false });
  add(0, "meta.tabs.snapshot", {
    reason: "start",
    level: "allow",
    origin: SYNTHETIC_ORIGIN,
    site: "example.test",
    tabs: [
      relatedTab(41, SYNTHETIC_ORIGIN, "/inbox", "Inbox"),
      relatedTab(42, "https://admin.example.test", "/users", "Users")
    ]
  });
  consoleError(50, "Failed to load resource: net::ERR_ADDRESS_INVALID", {
    source: "cdp.log",
    url: "https://tracker.example.net/tag/a1",
    networkRequestId: "90080.1122"
  });
  request(40, 12, {
    reqId: "90080.1122",
    url: "https://tracker.example.net/tag/a1",
    type: "Script",
    errorText: "net::ERR_ADDRESS_INVALID"
  });
  screenshot(200, errorPage, "initial", 480, 320);
  add(300, "storage.local.snapshot", {
    reason: "start",
    truncated: false,
    count: 2,
    mode: "full",
    redacted: false,
    entries: [
      { key: "lang", valueLength: 2, value: "en" },
      { key: "clientId", valueLength: 4, value: "1001" }
    ]
  });
  pointer(1_100, 700, 420);
  pointer(1_250, 600, 360);
  pointer(1_400, 500, 318);
  click(
    1_470,
    "A-000001",
    480,
    312,
    "500 Error — Try reloading the page",
    "div.error-page__wrapper button"
  );
  request(1_520, 239, {
    reqId: "6C7A98C2300C91EF0EACF13362576AEC",
    act: "A-000001",
    url: APP_URL,
    type: "Document",
    mimeType: "text/html"
  });
  add(
    1_910,
    "nav.commit",
    {
      type: "Navigation",
      frame: { id: MAIN_FRAME, loaderId: "L1", url: APP_URL, securityOrigin: SYNTHETIC_ORIGIN }
    },
    { ref: { act: "A-000001" } }
  );
  add(2_320, "nav.commit", {
    type: "Navigation",
    frame: { id: CHILD_FRAME, parentId: MAIN_FRAME, loaderId: "L2", url: "about:blank" }
  });
  request(1_990, 18, {
    reqId: "90080.1268",
    act: "A-000001",
    url: "https://tracker.example.net/collect",
    errorText: "net::ERR_ADDRESS_INVALID"
  });
  add(2_590, "nav.hash", {
    frameId: MAIN_FRAME,
    navigationType: "historyApi",
    url: `${APP_URL}#/error`
  });
  screenshot(2_700, errorPage, "after-navigation", 520, 330);
  request(3_400, 64, {
    reqId: "90080.1300",
    url: "https://cdn.example.test/app/config.json",
    errorText: "net::ERR_CONNECTION_RESET"
  });
  add(4_660, "nav.hash", {
    frameId: MAIN_FRAME,
    navigationType: "historyApi",
    url: `${APP_URL}#/`
  });
  add(6_450, "nav.hash", {
    frameId: MAIN_FRAME,
    navigationType: "historyApi",
    url: `${APP_URL}#/error`
  });
  add(6_500, "storage.session.op", {
    op: "setItem",
    redacted: false,
    key: "lastRoute",
    valueLength: 7,
    value: "#/error",
    ...route(`${APP_URL}#/error`)
  });
  request(9_420, 155, {
    reqId: "90080.1601",
    url: `${SYNTHETIC_ORIGIN}/gw/bff/tournaments/api/v1/group/1/active`,
    status: 401,
    statusText: "Unauthorized",
    mimeType: "application/problem+json",
    responseHeaders: { "www-authenticate": 'Bearer error="invalid_token"' },
    body: JSON.stringify({ title: "Unauthorized", status: 401, detail: "invalid_token" })
  });
  add(9_450, "nav.history.push", {
    frameId: MAIN_FRAME,
    navigationType: "historyApi",
    url: `${APP_URL}#/lobby`
  });
  screenshot(9_520, lobby, "after-navigation", 384, 400);
  request(9_770, 40, {
    reqId: "90080.1620",
    url: `${SYNTHETIC_ORIGIN}/assets/resources/undefined`,
    status: 404,
    statusText: "Not Found",
    mimeType: "text/html"
  });
  socket(9_930, "90080.1659", "/proxy-game/game", [
    [20, "sent", `{"protocol":"json","version":1}${RS}`],
    [60, "received", `{}${RS}`],
    [90, "sent", `{"type":6}${RS}`],
    [
      140,
      "sent",
      `{"target":"GamesTimeTableSubscribe","arguments":[],"invocationId":"0","type":1}${RS}`
    ],
    [
      420,
      "received",
      `{"type":1,"target":"GamesTimeTable","arguments":[{"games":[64,65,66]}]}${RS}`,
      6_786
    ]
  ]);
  pointer(10_300, 640, 260);
  pointer(10_600, 470, 360);
  pointer(10_740, 400, 395);
  click(
    10_770,
    "A-000002",
    384,
    400,
    "Live table 64",
    "#lobbyGame_64 picture > img",
    `${APP_URL}#/lobby`
  );
  request(10_800, 70, {
    reqId: "90080.1700",
    act: "A-000002",
    url: `${SYNTHETIC_ORIGIN}/gw/bff/games/api/v1.0/game/64`,
    body: JSON.stringify({ id: 64, title: "Live table 64", status: "open" })
  });
  request(10_870, 140, {
    reqId: "90080.1704",
    act: "A-000002",
    url: `${SYNTHETIC_ORIGIN}/gw/bff/tournaments/api/v1/group/2/active`,
    status: 401,
    statusText: "Unauthorized",
    mimeType: "application/problem+json",
    responseHeaders: { "www-authenticate": 'Bearer error="invalid_token"' }
  });
  request(10_890, 162, {
    reqId: "90080.1706",
    act: "A-000002",
    url: `${SYNTHETIC_ORIGIN}/gw/bff/users/api/v1.0/casino-user`,
    status: 401,
    statusText: "Unauthorized",
    mimeType: "application/problem+json",
    responseHeaders: { "www-authenticate": 'Bearer error="invalid_token"' },
    body: JSON.stringify({ title: "Unauthorized", status: 401, detail: "invalid_token" })
  });
  consoleError(11_070, "AuthError: casino-user request rejected (401 invalid_token)", {
    stackTop: "ensureCasinoUser (https://app.example.test/static/js/main.js:1:20412)"
  });
  add(
    11_075,
    "error.exception",
    {
      message: "AuthError: casino-user request rejected (401 invalid_token)",
      name: "AuthError",
      stack:
        "AuthError: casino-user request rejected\n    at ensureCasinoUser (https://app.example.test/static/js/main.js:1:20412)"
    },
    { lvl: "error" }
  );
  add(10_980, "nav.hash", {
    frameId: MAIN_FRAME,
    navigationType: "historyApi",
    url: `${APP_URL}#/live/64`
  });
  screenshot(11_200, game, "after-navigation", 472, 290);

  for (const [index, offsetMs] of [11_440, 11_470, 11_520].entries()) {
    request(offsetMs, 90, {
      reqId: `90080.173${index}`,
      act: "A-000002",
      url: `${SYNTHETIC_ORIGIN}/gw/bff/chats/api/v1.0/chats/${index + 1}`,
      status: 401,
      statusText: "Unauthorized",
      mimeType: "application/problem+json"
    });
  }

  socket(11_590, "90080.1737", "/proxy-live/hubs", [
    [30, "sent", `{"protocol":"json","version":1}${RS}`],
    [80, "received", `{}${RS}`],
    [
      150,
      "sent",
      `{"target":"GameStateSubscribe","arguments":[64],"invocationId":"1","type":1}${RS}`
    ],
    [260, "received", `{"type":1,"target":"GameState","arguments":[{"table":64,"round":"…`, 6_786],
    [900, "received", `{"type":6}${RS}`]
  ]);
  pointer(12_900, 520, 300);
  pointer(13_100, 485, 292);

  for (const [index, offsetMs] of [13_150, 13_980, 14_490].entries()) {
    const act = `A-00000${index + 3}`;
    click(offsetMs, act, 480, 290, "Retry", "#game-app button.btn--large", `${APP_URL}#/live/64`);
    request(offsetMs + 40, 120, {
      reqId: `90080.18${index}0`,
      act,
      url: `${SYNTHETIC_ORIGIN}/gw/bff/users/api/v1.0/casino-user`,
      status: 401,
      statusText: "Unauthorized",
      mimeType: "application/problem+json"
    });
  }

  screenshot(15_000, game, "idle", 480, 290);
  add(SYNTHETIC_DURATION_MS, "user.visibility", { state: "hidden" });

  addSyntheticNetworkEvents({ add, addBlob, request, origin: SYNTHETIC_ORIGIN });

  events.sort((left, right) => left.mono - right.mono || left.id.localeCompare(right.id));

  return {
    events,
    blobs,
    manifest: {
      protocolVersion: 1,
      createdAt: new Date(BASE_T).toISOString(),
      mode: "full",
      site: { origin: SYNTHETIC_ORIGIN, title: "Synthetic Replay Session" },
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
        chunkCount: 1,
        blobCount: blobs.length,
        durationMs: SYNTHETIC_DURATION_MS
      }
    }
  };
}

function relatedTab(tabId, origin, path, title) {
  return {
    tabId,
    windowId: 1,
    relation: origin === SYNTHETIC_ORIGIN ? "same-origin" : "same-site",
    origin,
    path,
    title,
    active: false,
    focused: false,
    incognito: false,
    discarded: false,
    frozen: false,
    firstSeenAt: BASE_T - 60_000,
    lastAccessed: BASE_T - 30_000
  };
}

/** The request index and chunk metadata both archive writers need. */
export function buildArchiveIndexes(session, chunkBytes) {
  const requestIndex = new Map();

  for (const event of session.events) {
    const reqId = event.ref?.req;

    if (reqId) {
      requestIndex.set(reqId, [...(requestIndex.get(reqId) ?? []), event.id]);
    }
  }

  const monos = session.events.map((event) => event.mono);
  const times = session.events.map((event) => event.t);

  return {
    timeIndex: [
      {
        chunkId: "C-000001",
        seq: 1,
        tStart: Math.min(...times),
        tEnd: Math.max(...times),
        monoStart: Math.min(...monos),
        monoEnd: Math.max(...monos),
        eventCount: session.events.length,
        byteLength: chunkBytes.byteLength,
        codec: "none",
        sha256: sha256Hex(chunkBytes)
      }
    ],
    requestIndex: [...requestIndex].map(([reqId, eventIds]) => ({ reqId, eventIds })),
    invertedIndex: []
  };
}

export function encodeEventChunk(events) {
  return new TextEncoder().encode(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

/** Unencrypted (format 1) archive bytes, like archives exported before encryption was required. */
export async function createPlainArchive(session = buildSyntheticSession()) {
  const zip = new JSZip();
  const chunkBytes = encodeEventChunk(session.events);
  const indexes = buildArchiveIndexes(session, chunkBytes);

  // Node Buffers: JSZip rejects typed arrays from another realm (e.g. jsdom test environments).
  zip.file("events/C-000001.ndjson", Buffer.from(chunkBytes));
  zip.file("index/time.json", JSON.stringify(indexes.timeIndex));
  zip.file("index/req.json", JSON.stringify(indexes.requestIndex));
  zip.file("index/inv.json", JSON.stringify(indexes.invertedIndex));

  for (const blob of session.blobs) {
    const extension = blob.mime === "image/png" ? "png" : "json";
    zip.file(`blobs/sha256-${blob.hash}.${extension}`, Buffer.from(blob.bytes));
  }

  zip.file("manifest.json", JSON.stringify(session.manifest));

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
