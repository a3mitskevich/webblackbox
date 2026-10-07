// Local servers for the takes, reachable from Windows Chrome on localhost (WSL mirrored networking):
//   demo shop  http://localhost:<demoPort>/   site/ + /api/login, /api/orders, /api/report (500),
//              /ws/notifications (WebSocket pushing fake order notifications)
//   Player     http://localhost:<playerPort>/ the current apps/player/build
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE_DIR = join(HERE, "..", "site");
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const NOTIFICATION_INTERVAL_MS = 4000;
const MAX_JSON_BODY_BYTES = 64 * 1024;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".webm": "video/webm",
  ".zip": "application/zip"
};

const ORDERS = [
  { id: "1041", customer: "Ирина Смирнова", total: "4 320 ₽", status: "Оплачен" },
  { id: "1042", customer: "Олег Петров", total: "1 990 ₽", status: "Собирается" },
  { id: "1043", customer: "Анна Ковалёва", total: "12 450 ₽", status: "Доставляется" },
  { id: "1044", customer: "Дмитрий Орлов", total: "760 ₽", status: "Ожидает оплаты" },
  { id: "1045", customer: "Мария Белова", total: "3 105 ₽", status: "Оплачен" },
  { id: "1046", customer: "Сергей Волков", total: "8 990 ₽", status: "Возврат" }
];

const NOTIFICATIONS = [
  "Новый заказ №1047 — 2 540 ₽",
  "Заказ №1042 передан в доставку",
  "Оплата по заказу №1044 получена",
  "Новый заказ №1048 — 640 ₽"
];

function sendJson(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.byteLength,
    "cache-control": "no-store"
  });
  response.end(payload);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > MAX_JSON_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

/** Serves `root` statically; refuses paths that escape it. */
async function serveStatic(root, pathname, response) {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/u, "");
  const absolute = resolve(root, relative === "" ? "index.html" : relative);
  if (absolute !== resolve(root) && !absolute.startsWith(`${resolve(root)}${sep}`)) {
    response.writeHead(403).end();
    return;
  }
  const file = absolute.endsWith(sep) ? join(absolute, "index.html") : absolute;
  try {
    const body = await readFile(file);
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store"
    });
    response.end(body);
  } catch {
    try {
      const body = await readFile(join(file, "index.html"));
      response.writeHead(200, { "content-type": CONTENT_TYPES[".html"] });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  }
}

async function handleDemo(request, response) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/api/login" && request.method === "POST") {
    const body = await readJsonBody(request);
    if (!body?.email || !body?.password) {
      sendJson(response, 401, { error: "invalid_credentials" });
      return;
    }
    sendJson(response, 200, { token: "demo-session-token", user: { name: "QA Тестировщик" } });
    return;
  }
  if (url.pathname === "/favicon.ico") {
    // No favicon, but no 404 either: it would show up as a "problem" in every recording.
    response.writeHead(204, { "cache-control": "max-age=86400" }).end();
    return;
  }
  if (url.pathname === "/api/orders") {
    sendJson(response, 200, { page: 1, orders: ORDERS });
    return;
  }
  if (url.pathname === "/api/report") {
    sendJson(response, 500, {
      error: "report_service_unavailable",
      message: "Сервис отчётов недоступен",
      traceId: "demo-7f3a91"
    });
    return;
  }
  await serveStatic(SITE_DIR, url.pathname, response);
}

function encodeTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const header =
    payload.byteLength < 126
      ? Buffer.from([0x81, payload.byteLength])
      : Buffer.from([0x81, 126, payload.byteLength >> 8, payload.byteLength & 0xff]);
  return Buffer.concat([header, payload]);
}

function attachNotifications(server) {
  const sockets = new Set();
  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/ws/notifications" || !key) {
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
    let next = 0;
    const push = () => {
      const text = NOTIFICATIONS[next % NOTIFICATIONS.length];
      next += 1;
      socket.write(encodeTextFrame(JSON.stringify({ type: "notification", text })));
    };
    const timer = setInterval(push, NOTIFICATION_INTERVAL_MS);
    setTimeout(push, 600);
    const entry = { socket, timer };
    sockets.add(entry);
    const drop = () => {
      clearInterval(timer);
      sockets.delete(entry);
    };
    socket.on("data", () => undefined);
    socket.on("close", drop);
    socket.on("error", drop);
  });
  return () => {
    for (const { socket, timer } of sockets) {
      clearInterval(timer);
      socket.destroy();
    }
    sockets.clear();
  };
}

function listen(server, port) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveListen());
  });
}

/** Starts the demo shop and the Player; `close()` stops both. */
export async function startDemoServers({ demoPort, playerPort, playerDir }) {
  const demo = createServer((request, response) => {
    handleDemo(request, response).catch(() => response.writeHead(500).end());
  });
  const closeSockets = attachNotifications(demo);
  const player = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    serveStatic(playerDir, url.pathname, response).catch(() => response.writeHead(500).end());
  });
  await listen(demo, demoPort);
  await listen(player, playerPort);
  return {
    demoUrl: `http://localhost:${demoPort}/`,
    playerUrl: `http://localhost:${playerPort}/`,
    async close() {
      closeSockets();
      await Promise.all([
        new Promise((done) => demo.close(done)),
        new Promise((done) => player.close(done))
      ]);
    }
  };
}
