// Shared Chrome/CDP plumbing for player e2e scripts: a static server for the built player,
// Chrome launch with retries, a minimal CDP client and polling helpers (Node 22+, no deps).
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { constants, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rm, stat } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { extname, isAbsolute, resolve, sep } from "node:path";

export const CHROME_CANDIDATES = [
  process.env.WB_E2E_CHROME_BIN,
  "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "google-chrome",
  "google-chrome-stable",
  "chromium-browser",
  "chromium"
].filter(Boolean);

export async function startPlayerServer(rootDir) {
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const relativePath =
        decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "") || "index.html";
      await serveStatic(response, rootDir, relativePath);
    } catch (error) {
      writeJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve local player server address.");
  }

  return {
    server,
    port: address.port
  };
}
async function serveStatic(response, rootDir, relativePath) {
  const safeRelative = normalizeRelativePath(relativePath);
  const resolved = resolve(rootDir, safeRelative);
  const guardedRoot = rootDir.endsWith(sep) ? rootDir : `${rootDir}${sep}`;

  if (resolved !== rootDir && !resolved.startsWith(guardedRoot)) {
    writeJson(response, 403, {
      ok: false,
      error: "path-traversal"
    });
    return;
  }

  let filePath = resolved;

  try {
    const info = await stat(filePath);

    if (info.isDirectory()) {
      filePath = resolve(filePath, "index.html");
    }
  } catch {
    writeJson(response, 404, {
      ok: false,
      error: "asset-not-found",
      path: relativePath
    });
    return;
  }

  let bytes;

  try {
    bytes = await readFile(filePath);
  } catch {
    writeJson(response, 404, {
      ok: false,
      error: "asset-not-found",
      path: relativePath
    });
    return;
  }

  response.writeHead(200, {
    "content-type": mimeTypeFor(filePath),
    "cache-control": "no-store",
    "content-length": bytes.byteLength
  });
  response.end(bytes);
}
function normalizeRelativePath(value) {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  return normalized.length > 0 ? normalized : "index.html";
}
function mimeTypeFor(path) {
  const extension = extname(path).toLowerCase();

  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }

  if (extension === ".js") {
    return "text/javascript; charset=utf-8";
  }

  if (extension === ".css") {
    return "text/css; charset=utf-8";
  }

  if (extension === ".json") {
    return "application/json; charset=utf-8";
  }

  if (extension === ".png") {
    return "image/png";
  }

  if (extension === ".woff2") {
    return "font/woff2";
  }

  if (extension === ".svg") {
    return "image/svg+xml";
  }

  if (extension === ".ico") {
    return "image/x-icon";
  }

  if (extension === ".map") {
    return "application/json; charset=utf-8";
  }

  return "application/octet-stream";
}
function writeJson(response, status, payload) {
  const bytes = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": bytes.byteLength
  });
  response.end(bytes);
}
export async function resolveChromeBinary(candidates) {
  for (const candidate of candidates) {
    const resolved = await resolveExecutable(candidate);

    if (resolved) {
      return resolved;
    }
  }

  throw new Error(
    "Unable to find Chrome. Set WB_E2E_CHROME_BIN to a Chrome or Chromium executable."
  );
}
async function resolveExecutable(candidate) {
  if (!candidate) {
    return null;
  }

  const trimmed = candidate.trim();

  if (!trimmed) {
    return null;
  }

  if (isAbsolute(trimmed) || trimmed.startsWith(".")) {
    try {
      await access(trimmed, constants.X_OK);
      return trimmed;
    } catch {
      return null;
    }
  }

  const which = spawnSync("which", [trimmed], {
    encoding: "utf8"
  });

  if (which.status !== 0) {
    return null;
  }

  const resolved = which.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!resolved) {
    return null;
  }

  try {
    await access(resolved, constants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}
export async function launchChromeWithRetry(binary, options) {
  let lastError = null;

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const attemptProfileDir =
      attempt === 1 ? options.profileDir : `${options.profileDir}-retry-${attempt}`;
    const attemptLogPath =
      attempt === 1
        ? options.logPath
        : options.logPath.replace(/(\.[^.]+)?$/, `-retry-${attempt}$1`);

    await rm(attemptProfileDir, { recursive: true, force: true });
    await mkdir(attemptProfileDir, { recursive: true });

    const remotePort =
      attempt === 1 && Number.isFinite(options.requestedRemotePort)
        ? options.requestedRemotePort
        : await reserveEphemeralPort();
    const baseUrl = `http://127.0.0.1:${remotePort}`;
    const { proc, logStream } = startChrome(binary, {
      profileDir: attemptProfileDir,
      remotePort,
      headless: options.headless,
      logPath: attemptLogPath
    });

    try {
      const version = await waitForChromeReady(baseUrl, options.readyTimeoutMs, {
        proc,
        logPath: attemptLogPath
      });
      return {
        proc,
        logStream,
        baseUrl,
        remotePort,
        profileDir: attemptProfileDir,
        version
      };
    } catch (error) {
      lastError = error;
      await terminateChromeProcess(proc);
      logStream.end();

      if (attempt < options.attempts) {
        console.warn(
          `Chrome launch attempt ${attempt} failed; retrying with a fresh profile. ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
function startChrome(binary, options) {
  const args = [
    `--remote-debugging-port=${options.remotePort}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${options.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-popup-blocking",
    "--window-size=1400,1000",
    "--enable-logging=stderr",
    "about:blank"
  ];

  if (options.headless) {
    args.unshift("--headless=new");
  }

  if (process.platform === "linux") {
    args.unshift("--disable-dev-shm-usage");
    args.unshift("--disable-setuid-sandbox");
    args.unshift("--no-sandbox");
  }

  const proc = spawn(binary, args, {
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logStream = createWriteStream(options.logPath, { flags: "a" });

  proc.stdout?.pipe(logStream);
  proc.stderr?.pipe(logStream);

  proc.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      console.warn(`Chrome exited with code ${code}.`);
    }

    if (signal) {
      console.warn(`Chrome exited via signal ${signal}.`);
    }
  });

  return {
    proc,
    logStream
  };
}
async function waitForChromeReady(urlBase, timeoutMs, context = undefined) {
  try {
    return await waitFor(
      async () => {
        if (context?.proc?.exitCode !== null && context?.proc?.exitCode !== undefined) {
          throw new Error(
            `Chrome exited before DevTools was ready (exitCode=${context.proc.exitCode}).`
          );
        }

        if (context?.proc?.signalCode) {
          throw new Error(
            `Chrome exited before DevTools was ready (signalCode=${context.proc.signalCode}).`
          );
        }

        const version = await fetchJson(`${urlBase}/json/version`, 4_000);
        return version?.Browser ? version : null;
      },
      timeoutMs,
      250,
      "Chrome DevTools endpoint not ready"
    );
  } catch (error) {
    const logTail = context?.logPath ? await readLogTail(context.logPath, 40).catch(() => "") : "";
    const suffix = logTail ? `\nChrome log tail:\n${logTail}` : "";
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}${suffix}`);
  }
}
async function readLogTail(path, maxLines) {
  const content = await readFile(path, "utf8");
  const lines = content
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  return lines.slice(-maxLines).join("\n");
}
async function reserveEphemeralPort() {
  const server = createNetServer();

  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Failed to reserve an ephemeral port.");
  }

  const port = address.port;

  await new Promise((resolvePromise) => {
    server.close(() => resolvePromise());
  });

  return port;
}
export async function openTarget(urlBase, url) {
  const target = await fetchJson(`${urlBase}/json/new?${encodeURIComponent(url)}`, 6_000, {
    method: "PUT"
  });

  if (!target?.id || !target?.webSocketDebuggerUrl) {
    throw new Error(`Failed to open target: ${url}`);
  }

  return target;
}
export async function closeTarget(urlBase, targetId) {
  try {
    await fetchJson(`${urlBase}/json/close/${targetId}`, 4_000);
  } catch {
    // Ignore cleanup failures after the browser has already started shutting down.
  }
}
export async function fetchJson(url, timeoutMs, init) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.json();
}
export async function waitFor(fn, timeoutMs, intervalMs, timeoutMessage) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const result = await fn();

      if (result !== null && result !== undefined) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(intervalMs);
  }

  if (lastError instanceof Error) {
    throw new Error(`${timeoutMessage}: ${lastError.message}`);
  }

  throw new Error(timeoutMessage);
}
export function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
// `proc.killed` turns true once a signal is delivered, not when Chrome exits; check the exit instead.
function hasExited(proc) {
  return proc.exitCode !== null || proc.signalCode !== null;
}

export async function terminateChromeProcess(proc) {
  if (!proc || hasExited(proc)) {
    return;
  }

  proc.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => {
      proc.once("exit", resolvePromise);
    }),
    sleep(5_000)
  ]);

  if (!hasExited(proc)) {
    proc.kill("SIGKILL");
    await Promise.race([
      new Promise((resolvePromise) => {
        proc.once("exit", resolvePromise);
      }),
      sleep(2_000)
    ]);
  }
}
/** Bounds every CDP command, so a hung page (dialog, stuck renderer) fails the run instead of hanging it. */
const CDP_COMMAND_TIMEOUT_MS = 30_000;
const CDP_CONNECT_TIMEOUT_MS = 15_000;

export class CdpClient {
  constructor(wsUrl, commandTimeoutMs = CDP_COMMAND_TIMEOUT_MS) {
    this.wsUrl = wsUrl;
    this.commandTimeoutMs = commandTimeoutMs;
    this.socket = null;
    this.sequence = 0;
    this.pending = new Map();
    this.eventHandlers = new Map();
  }

  async connect() {
    await new Promise((resolvePromise, reject) => {
      const socket = new WebSocket(this.wsUrl);
      this.socket = socket;
      const timer = setTimeout(() => {
        reject(new Error(`Timed out opening WebSocket: ${this.wsUrl}`));
        socket.close();
      }, CDP_CONNECT_TIMEOUT_MS);

      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolvePromise();
      });

      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`Failed to open WebSocket: ${this.wsUrl}`));
      });

      socket.addEventListener("close", () => {
        clearTimeout(timer);
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("CDP socket closed"));
        }
        this.pending.clear();
      });

      socket.addEventListener("message", (eventMessage) => {
        const payload = JSON.parse(String(eventMessage.data));

        if (typeof payload.id === "number") {
          const pending = this.pending.get(payload.id);

          if (!pending) {
            return;
          }

          this.pending.delete(payload.id);
          clearTimeout(pending.timer);

          if (payload.error) {
            pending.reject(new Error(payload.error.message ?? JSON.stringify(payload.error)));
            return;
          }

          pending.resolve(payload.result);
          return;
        }

        if (typeof payload.method === "string") {
          const handlers = this.eventHandlers.get(payload.method) ?? [];

          for (const handler of handlers) {
            handler(payload.params ?? {});
          }
        }
      });
    });
  }

  on(method, handler) {
    const handlers = this.eventHandlers.get(method) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(method, handlers);
  }

  send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP socket is not open"));
    }

    const id = ++this.sequence;
    const message = JSON.stringify({
      id,
      method,
      params
    });

    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${this.commandTimeoutMs} ms`));
      }, this.commandTimeoutMs);
      this.pending.set(id, {
        resolve: resolvePromise,
        reject,
        timer
      });
      this.socket.send(message);
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });

    if (result?.exceptionDetails) {
      const message = result.exceptionDetails.text ?? "Runtime.evaluate failed";
      throw new Error(message);
    }

    return result?.result?.value;
  }

  close() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close();
    }
  }
}
