// The bug zoo fixture server: serves every scenario's pages, scripts, API and WebSockets from one
// loopback origin. State (order counters, cart quantity) lives in the server instance, so each
// recording starts a fresh server.

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import type { ApiReply, ApiRequest, Scenario, ScenarioSocket, ScenarioState } from "../types.js";
import { renderPage } from "./layout.js";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const WS_OPCODE_TEXT = 0x1;
const WS_OPCODE_CLOSE = 0x8;
const WS_FIN = 0x80;

export type BugZooSite = {
  origin: string;
  port: number;
  close(): Promise<void>;
};

/** Starts the fixture on 127.0.0.1 (a random port unless `port` is given). */
export async function startBugZooSite(
  scenarios: readonly Scenario[],
  { port = 0 }: { port?: number } = {}
): Promise<BugZooSite> {
  const state: ScenarioState = new Map();
  const routes = buildRoutes(scenarios);
  const held = new Set<ServerResponse>();
  const sockets = new Set<Duplex>();
  const server = createServer((request, response) => {
    handleRequest(request, response, routes, state, held).catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "text/plain" });
      }

      response.end(error instanceof Error ? error.message : String(error));
    });
  });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    acceptWebSocket(request, socket, routes.sockets);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    origin: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    async close() {
      for (const response of held) {
        response.destroy();
      }

      for (const socket of sockets) {
        socket.destroy();
      }

      held.clear();
      sockets.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

type Routes = {
  pages: Map<string, string>;
  scripts: Map<string, string>;
  api: Map<string, NonNullable<Scenario["api"]>[string]>;
  sockets: Map<string, NonNullable<Scenario["sockets"]>[string]>;
};

function buildRoutes(scenarios: readonly Scenario[]): Routes {
  const routes: Routes = {
    pages: new Map([["/", renderHome(scenarios)]]),
    scripts: new Map(),
    api: new Map(),
    sockets: new Map()
  };

  for (const scenario of scenarios) {
    addUnique(routes.pages, scenario.pages, scenario.id);
    addUnique(routes.scripts, scenario.scripts ?? {}, scenario.id);
    addUnique(routes.api, scenario.api ?? {}, scenario.id);
    addUnique(routes.sockets, scenario.sockets ?? {}, scenario.id);
  }

  return routes;
}

function addUnique<T>(
  target: Map<string, T>,
  entries: Readonly<Record<string, T>>,
  owner: string
): void {
  for (const [key, value] of Object.entries(entries)) {
    if (target.has(key)) {
      throw new Error(`Route ${key} of ${owner} is already taken by another scenario`);
    }

    target.set(key, value);
  }
}

/** A neutral landing page: the recording starts here before the tester opens the scenario. */
function renderHome(scenarios: readonly Scenario[]): string {
  const links = scenarios
    .flatMap((scenario) => Object.keys(scenario.pages))
    .filter((path) => path.endsWith("/"))
    .map((path) => `<li><a href="${path}">${path}</a></li>`)
    .join("");

  return renderPage({ title: "Home", body: `<h1>Welcome</h1><ul>${links}</ul>` });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  routes: Routes,
  state: ScenarioState,
  held: Set<ServerResponse>
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";
  const handler = routes.api.get(`${method} ${url.pathname}`);

  if (handler) {
    const body = await readBody(request);
    const apiRequest: ApiRequest = { method, url, headers: request.headers, body };
    await sendReply(response, handler(apiRequest, state), held);
    return;
  }

  const page = method === "GET" ? routes.pages.get(url.pathname) : undefined;

  if (page !== undefined) {
    send(response, 200, "text/html; charset=utf-8", page, { "cache-control": "no-store" });
    return;
  }

  const script = method === "GET" ? routes.scripts.get(url.pathname) : undefined;

  if (script !== undefined) {
    send(response, 200, "text/javascript; charset=utf-8", script, {
      "cache-control": "no-store"
    });
    return;
  }

  if (url.pathname === "/favicon.ico") {
    response.writeHead(204).end();
    return;
  }

  send(response, 404, "application/json", JSON.stringify({ error: "not_found" }));
}

async function sendReply(
  response: ServerResponse,
  reply: ApiReply,
  held: Set<ServerResponse>
): Promise<void> {
  if (reply.hold) {
    held.add(response);
    response.on("close", () => held.delete(response));
    return;
  }

  if (reply.delayMs) {
    await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
  }

  const isText = typeof reply.body === "string";
  const body =
    reply.body === undefined ? "" : isText ? String(reply.body) : JSON.stringify(reply.body);
  const contentType = isText ? "text/plain; charset=utf-8" : "application/json";
  send(response, reply.status, contentType, body, reply.headers);
}

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  headers: Readonly<Record<string, string>> = {}
): void {
  if (response.destroyed) {
    return;
  }

  response.writeHead(status, { "content-type": contentType, ...headers });
  response.end(body);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;

      if (size > MAX_REQUEST_BODY_BYTES) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/** Minimal RFC 6455 server side: handshake, unmasked server frames, close with a code. */
function acceptWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  handlers: Routes["sockets"]
): void {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const handler = handlers.get(url.pathname);
  const key = request.headers["sec-websocket-key"];

  if (!handler || typeof key !== "string") {
    socket.destroy();
    return;
  }

  const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
  socket.on("error", () => undefined);
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  let closed = false;
  const scenarioSocket: ScenarioSocket = {
    sendText(text) {
      if (!closed) {
        socket.write(encodeFrame(WS_OPCODE_TEXT, Buffer.from(text, "utf8")));
      }
    },
    close(code, reason) {
      if (closed) {
        return;
      }

      closed = true;
      const payload = Buffer.concat([Buffer.alloc(2), Buffer.from(reason, "utf8")]);
      payload.writeUInt16BE(code, 0);
      socket.end(encodeFrame(WS_OPCODE_CLOSE, payload));
    }
  };

  handler(scenarioSocket);
}

/** One unmasked server frame (payloads up to 64 KiB). */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  if (payload.byteLength < 126) {
    return Buffer.concat([Buffer.from([WS_FIN | opcode, payload.byteLength]), payload]);
  }

  const header = Buffer.alloc(4);
  header[0] = WS_FIN | opcode;
  header[1] = 126;
  header.writeUInt16BE(payload.byteLength, 2);
  return Buffer.concat([header, payload]);
}
