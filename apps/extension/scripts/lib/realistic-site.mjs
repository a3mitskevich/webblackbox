// A realistic fixture site for the capture-completeness e2e gate (and the local test stand): it
// reproduces what a real single-page app does to the recorder, which the small demo page never
// did — hundreds of parallel fetch/XHR calls with small JSON bodies, multi-MB JS bundles, POST
// bodies the browser does not inline (Blob, untyped) or cannot expose (streams), a SignalR-like
// WebSocket, a service worker proxying requests, and DOM churn for the whole session.
//
// `startRealisticSite()` serves it on its own loopback origin; the page exposes
// `window.__realistic.run(durationMs)`, which drives the traffic and resolves with a summary of
// what it did, so the gate can compare the archive with the ground truth.

import { createHash } from "node:crypto";
import { createServer } from "node:http";

export const REALISTIC_PAGE_PATH = "/app/";
export const REALISTIC_HUB_PATH = "/hubs/lobby";
export const REALISTIC_DEFAULT_DURATION_MS = 32_000;
/** Bundle sizes: one far over a 1 MiB body limit (too large), one cut at it, one kept whole. */
export const REALISTIC_BUNDLES = [
  { name: "vendor-charts.js", bytes: 2_600_000 },
  { name: "vendor-ui.js", bytes: 1_300_000 },
  { name: "app.js", bytes: 180_000 }
];
export const REALISTIC_STYLESHEETS = 24;

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const RECORD_SEPARATOR = "\u001e";
const HUB_PUSH_INTERVAL_MS = 400;
const LOBBY_FRAME_MIN_CHARS = 10_000;
// 1x1 transparent PNG.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/** Starts the site on 127.0.0.1 (random port by default). */
export async function startRealisticSite({ port = 0 } = {}) {
  const bundles = new Map(REALISTIC_BUNDLES.map((bundle) => [bundle.name, buildBundle(bundle)]));
  const sockets = new Set();
  const server = createServer((request, response) => {
    handleRequest(request, response, bundles).catch((error) => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "text/plain" });
      }

      response.end(String(error instanceof Error ? error.message : error));
    });
  });

  server.on("upgrade", (request, socket) => acceptHubSocket(request, socket, sockets));
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  return {
    origin,
    pageUrl: `${origin}${REALISTIC_PAGE_PATH}`,
    server,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }

      sockets.clear();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

async function handleRequest(request, response, bundles) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  const body = await readBody(request);

  if (path === "/" || path === REALISTIC_PAGE_PATH) {
    return send(response, 200, "text/html; charset=utf-8", buildPage(), {
      "cache-control": "no-store"
    });
  }

  if (path === "/sw.js") {
    return send(response, 200, "text/javascript", SERVICE_WORKER_SOURCE, {
      "cache-control": "no-store",
      "service-worker-allowed": "/"
    });
  }

  if (path.startsWith("/static/") && path.endsWith(".js")) {
    const bundle = bundles.get(path.slice("/static/".length));
    return bundle
      ? send(response, 200, "text/javascript; charset=utf-8", bundle, {
          "cache-control": "no-store"
        })
      : send(response, 404, "text/plain", "missing bundle");
  }

  if (path.startsWith("/static/") && path.endsWith(".css")) {
    return send(response, 200, "text/css", buildStylesheet(path), { "cache-control": "no-store" });
  }

  if (path.startsWith("/img/")) {
    return send(response, 200, "image/png", PNG_BYTES, { "cache-control": "no-store" });
  }

  if (path === "/favicon.ico") {
    return send(response, 204, "image/x-icon", "");
  }

  if (path.startsWith("/api/items/")) {
    return sendJson(response, buildItems(path.slice("/api/items/".length)));
  }

  if (path.startsWith("/api/text/")) {
    const row = `row ${path.slice("/api/text/".length)}\n`;
    return send(response, 200, "text/plain; charset=utf-8", row.repeat(40), {
      "cache-control": "no-store"
    });
  }

  if (path.startsWith("/api/slow/")) {
    await new Promise((resolve) => setTimeout(resolve, 150 + (path.length % 5) * 120));
    return sendJson(response, buildItems(`slow-${path.slice("/api/slow/".length)}`));
  }

  if (path.startsWith("/api/sw/")) {
    return sendJson(response, { via: "service-worker", id: path.slice(8), at: Date.now() });
  }

  if (path === "/api/poll") {
    return sendJson(response, { ok: true, at: Date.now() });
  }

  if (path.startsWith("/api/echo/")) {
    return sendJson(response, {
      variant: path.slice("/api/echo/".length),
      method: request.method,
      contentType: request.headers["content-type"] ?? null,
      received: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex")
    });
  }

  if (path === `${REALISTIC_HUB_PATH}/negotiate`) {
    return sendJson(response, {
      negotiateVersion: 1,
      connectionId: "fixture-connection",
      connectionToken: "fixture-token",
      availableTransports: [{ transport: "WebSockets", transferFormats: ["Text"] }]
    });
  }

  return send(response, 404, "text/plain", "not found");
}

function send(response, status, contentType, body, headers = {}) {
  response.writeHead(status, { "content-type": contentType, ...headers });
  response.end(body);
}

function sendJson(response, payload) {
  send(response, 200, "application/json; charset=utf-8", JSON.stringify(payload), {
    "cache-control": "no-store"
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/** About 1.4 KB of JSON, like the small API responses of the real site. */
function buildItems(id) {
  return {
    id,
    page: 1,
    items: Array.from({ length: 12 }, (_, index) => ({
      gameId: 90_000_000 + index,
      title: `Table ${id}-${index}`,
      state: index % 4,
      startsInSec: index * 7
    }))
  };
}

function buildStylesheet(path) {
  const name = path.replace(/\W+/g, "-");
  return Array.from(
    { length: 40 },
    (_, index) => `.${name}-${index} { margin: ${index}px; padding: ${index % 7}px; }`
  ).join("\n");
}

/** A valid script of about `bytes` length: a tiny module plus comment padding. */
function buildBundle({ name, bytes }) {
  const head = `/* ${name} */\nwindow.__bundles = (window.__bundles || []).concat(${JSON.stringify(name)});\n`;
  const line = `// ${"x".repeat(97)}\n`;
  const lines = Math.max(0, Math.floor((bytes - head.length) / line.length));
  return `${head}${line.repeat(lines)}`;
}

function buildLobbyFrame(sequence) {
  const games = [];
  let frame = "";

  while (frame.length < LOBBY_FRAME_MIN_CHARS) {
    games.push({ gameId: 90_000_467_807 + games.length, round: sequence, state: 4 });
    frame = `${JSON.stringify({ type: 1, target: "LobbyUpdated", arguments: [{ seq: sequence, data: games }] })}${RECORD_SEPARATOR}`;
  }

  return frame;
}

function acceptHubSocket(request, socket, sockets) {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const key = request.headers["sec-websocket-key"];

  if (pathname !== REALISTIC_HUB_PATH || typeof key !== "string") {
    socket.destroy();
    return;
  }

  const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      ""
    ].join("\r\n")
  );
  sockets.add(socket);

  let sequence = 0;
  let handshakeDone = false;
  let buffered = Buffer.alloc(0);
  const timer = setInterval(() => {
    sequence += 1;
    // Mostly small invocations; every tenth one is a ~10 KB lobby update.
    const message =
      sequence % 10 === 0
        ? buildLobbyFrame(sequence)
        : `${JSON.stringify({ type: 1, target: "Tick", arguments: [{ seq: sequence }] })}${RECORD_SEPARATOR}`;
    socket.write(encodeTextFrame(message));
  }, HUB_PUSH_INTERVAL_MS);

  const close = () => {
    clearInterval(timer);
    sockets.delete(socket);
  };

  socket.on("close", close);
  socket.on("error", close);
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);

    for (let frame = decodeFrame(buffered); frame; frame = decodeFrame(buffered)) {
      buffered = buffered.subarray(frame.consumed);

      if (frame.opcode === 0x8) {
        socket.end();
        return;
      }

      if (!handshakeDone && frame.text.includes('"protocol"')) {
        handshakeDone = true;
        socket.write(encodeTextFrame(`{}${RECORD_SEPARATOR}`));
      } else if (frame.text.includes('"type":6')) {
        socket.write(encodeTextFrame(`{"type":6}${RECORD_SEPARATOR}`));
      }
    }
  });
}

function encodeTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const length = payload.byteLength;

  if (length < 126) {
    return Buffer.concat([Buffer.from([0x81, length]), payload]);
  }

  if (length < 65_536) {
    return Buffer.concat([Buffer.from([0x81, 126, length >> 8, length & 0xff]), payload]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

/** Decodes one (masked) client frame from the start of `buffer`, or null when incomplete. */
function decodeFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }

  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < 4) {
      return null;
    }

    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) {
      return null;
    }

    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  const maskOffset = offset;
  offset += masked ? 4 : 0;

  if (buffer.length < offset + length) {
    return null;
  }

  const payload = Buffer.from(buffer.subarray(offset, offset + length));

  if (masked) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= buffer[maskOffset + (index % 4)];
    }
  }

  return { opcode, text: payload.toString("utf8"), consumed: offset + length };
}

const SERVICE_WORKER_SOURCE = `
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (new URL(event.request.url).pathname.startsWith('/api/sw/')) {
    event.respondWith(fetch(event.request));
  }
});
`;

function buildPage() {
  // Bundles and stylesheets load lazily from `run()` (like SPA chunks), so they fall inside the
  // recording instead of before it starts.
  const assets = {
    stylesheets: Array.from(
      { length: REALISTIC_STYLESHEETS },
      (_, index) => `/static/theme-${index}.css`
    ),
    scripts: REALISTIC_BUNDLES.map((bundle) => `/static/${bundle.name}`)
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Realistic fixture</title>
<script>window.__realisticAssets = ${JSON.stringify(assets)};</script>
</head>
<body>
<header><h1>Lobby</h1><button id="refresh" type="button">Refresh</button></header>
<main>
  <section id="tables" aria-live="polite"></section>
  <section id="ticker"></section>
  <img src="/img/logo.png" alt="">
</main>
<script>${PAGE_SCRIPT}</script>
</body>
</html>`;
}

// The page's traffic and DOM churn, as plain browser JavaScript (no build step).
const PAGE_SCRIPT = `
(() => {
  const RS = String.fromCharCode(0x1e);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const summary = {
    fetches: 0, xhrs: 0, posts: 0, serviceWorker: 0, polls: 0,
    wsSent: 0, wsReceived: 0, domMutations: 0, errors: []
  };

  function track(promise, label) {
    return promise.catch((error) => {
      summary.errors.push(label + ': ' + String((error && error.message) || error));
    });
  }

  function getJson(url) {
    summary.fetches += 1;
    return track(fetch(url, { cache: 'no-store' }).then((response) => response.json()), url);
  }

  function getXhr(url) {
    summary.xhrs += 1;
    return track(new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.onload = () => resolve(xhr.responseText);
      xhr.onerror = () => reject(new Error('xhr failed'));
      xhr.send();
    }), url);
  }

  async function burst(wave, size) {
    const tasks = [];

    for (let index = 0; index < size; index += 1) {
      const id = wave + '-' + index;
      tasks.push(index % 4 === 3 ? getXhr('/api/text/' + id) : getJson('/api/items/' + id));
    }

    tasks.push(getJson('/api/slow/' + wave));
    await Promise.all(tasks);
  }

  async function postVariants() {
    const echo = (variant) => '/api/echo/' + variant;
    const json = JSON.stringify({ table: 64, stake: 2.5, note: 'completeness' });
    const jsonHeaders = { 'content-type': 'application/json' };
    const variants = [
      ['string', () => fetch(echo('string'), { method: 'POST', body: json })],
      ['json', () => fetch(echo('json'), { method: 'POST', body: json, headers: jsonHeaders })],
      ['blob-untyped', () => fetch(echo('blob-untyped'), { method: 'POST', body: new Blob([json]) })],
      ['blob-json', () => fetch(echo('blob-json'), {
        method: 'POST', body: new Blob([json], { type: 'application/json' })
      })],
      ['array-buffer', () => fetch(echo('array-buffer'), {
        method: 'POST', body: new TextEncoder().encode(json)
      })],
      ['url-params', () => fetch(echo('url-params'), {
        method: 'POST', body: new URLSearchParams({ q: 'lobby', page: '2' })
      })],
      ['put', () => fetch(echo('put'), { method: 'PUT', body: json, headers: jsonHeaders })],
      ['xhr', () => new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', echo('xhr'));
        xhr.onloadend = resolve;
        xhr.send(json);
      })],
      // Chrome cannot expose a streamed body (and HTTP/1.1 rejects it); it must not count as lost.
      ['stream', () => fetch(echo('stream'), {
        method: 'POST',
        duplex: 'half',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(json));
            controller.close();
          }
        })
      })]
    ];

    for (const [name, run] of variants) {
      summary.posts += 1;
      await track(Promise.resolve().then(run), 'post ' + name);
    }

    navigator.sendBeacon(echo('beacon'), json);
    summary.posts += 1;
  }

  async function connectHub() {
    await fetch('/hubs/lobby/negotiate?negotiateVersion=1', { method: 'POST' });
    const socket = new WebSocket('ws://' + location.host + '/hubs/lobby');
    socket.addEventListener('message', () => { summary.wsReceived += 1; });
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    const send = (text) => { socket.send(text + RS); summary.wsSent += 1; };
    send(JSON.stringify({ protocol: 'json', version: 1 }));
    // A large client invocation, like a batched bet slip (about 20 KB).
    send(JSON.stringify({
      type: 1,
      target: 'PlaceBets',
      arguments: [Array.from({ length: 400 }, (_, i) => ({ id: i, stake: 1 + i / 10 }))]
    }));
    return { socket, ping: () => send(JSON.stringify({ type: 6 })) };
  }

  function churnDom(tick) {
    const tables = document.getElementById('tables');
    const row = document.createElement('div');
    row.className = 'table-row state-' + (tick % 4);
    row.textContent = 'Table ' + tick + ' at ' + new Date().toISOString();
    tables.prepend(row);

    while (tables.children.length > 25) {
      tables.lastElementChild.remove();
    }

    const ticker = document.getElementById('ticker');
    ticker.setAttribute('data-tick', String(tick));
    ticker.textContent = 'Jackpot ' + (1000 + tick * 3);
    summary.domMutations += 1;
  }

  function seedStorage() {
    document.cookie = 'lobby_theme=dark; path=/';
    document.cookie = 'lobby_lang=en; path=/';
    localStorage.setItem('lobby.favorites', JSON.stringify([64, 65, 66]));
    localStorage.setItem('lobby.lastTable', '64');

    return new Promise((resolve) => {
      const open = indexedDB.open('lobby-cache', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('tables', { keyPath: 'id' });
      open.onerror = () => resolve(false);
      open.onsuccess = () => {
        const tx = open.result.transaction('tables', 'readwrite');
        for (let id = 1; id <= 5; id += 1) {
          tx.objectStore('tables').put({ id, name: 'Table ' + id, seats: id + 3 });
        }
        tx.oncomplete = () => { open.result.close(); resolve(true); };
        tx.onerror = () => resolve(false);
      };
    });
  }

  function loadAsset(tag, url) {
    return new Promise((resolve) => {
      const element = document.createElement(tag);

      if (tag === 'link') {
        element.rel = 'stylesheet';
        element.href = url;
      } else {
        element.src = url;
      }

      element.onload = () => resolve(true);
      element.onerror = () => { summary.errors.push('asset ' + url); resolve(false); };
      document.head.append(element);
    });
  }

  function loadAssets() {
    const assets = window.__realisticAssets;
    return Promise.all([
      ...assets.stylesheets.map((url) => loadAsset('link', url)),
      ...assets.scripts.map((url) => loadAsset('script', url))
    ]);
  }

  async function run(durationMs) {
    const startedAt = Date.now();
    const deadline = startedAt + durationMs;

    await loadAssets();

    if ('serviceWorker' in navigator) {
      await track(
        navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready),
        'service worker'
      );
    }

    await seedStorage();
    const hub = await connectHub();
    console.info('[realistic] session start', { durationMs });

    let tick = 0;
    const domTimer = setInterval(() => churnDom(tick++), 250);
    const pollTimer = setInterval(() => { summary.polls += 1; getJson('/api/poll'); }, 1000);
    const pingTimer = setInterval(() => hub.ping(), 2000);

    await burst('w1', 120);
    await postVariants();
    await Promise.all(Array.from({ length: 10 }, (_, i) => {
      summary.serviceWorker += 1;
      return track(fetch('/api/sw/' + i).then((response) => response.json()), 'sw ' + i);
    }));
    console.warn('[realistic] first wave done', { fetches: summary.fetches });
    console.error(new Error('[realistic] simulated handled failure with a stack'));

    let wave = 2;
    while (Date.now() < deadline) {
      await sleep(Math.min(6000, Math.max(0, deadline - Date.now())));
      if (Date.now() < deadline && wave <= 4) {
        await burst('w' + wave, 80);
        wave += 1;
      }
    }

    clearInterval(domTimer);
    clearInterval(pollTimer);
    clearInterval(pingTimer);
    await sleep(500);
    hub.socket.close();
    console.info('[realistic] session end', summary);

    const errors = summary.errors.filter((error) => !error.startsWith('post stream'));
    return { ok: errors.length === 0, elapsedMs: Date.now() - startedAt, ...summary };
  }

  window.__realistic = { run };
})();
`;
