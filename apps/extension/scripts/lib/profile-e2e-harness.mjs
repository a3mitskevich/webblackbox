// Shared harness of the profile e2e scripts: one Chrome with the unpacked extension, CDP clients
// for the service worker, the page under test and the popup (the control page), and helpers.

import { spawn, spawnSync } from "node:child_process";
import { constants, createWriteStream } from "node:fs";
import { access, mkdir, readdir, rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

/** Upper bound for any single CDP command, so a blocked page fails the run instead of hanging. */
const CDP_COMMAND_TIMEOUT_MS = 60_000;

const CHROME_CANDIDATES = [
  process.env.WB_E2E_CHROME_BIN,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "google-chrome",
  "chromium"
].filter(Boolean);

/**
 * @param {{ name: string, appRoot: string, defaultPort: string }} options
 */
export function createProfileE2eHarness({ name, appRoot, defaultPort }) {
  const extensionDir = process.env.WB_E2E_EXTENSION_DIR ?? resolve(appRoot, "build");
  const remotePort = Number(process.env.WB_E2E_REMOTE_PORT ?? defaultPort);
  const headless = (process.env.WB_E2E_HEADLESS ?? "1") !== "0";
  const runId = Date.now();
  const profileDir = process.env.WB_E2E_PROFILE_DIR ?? `/tmp/webblackbox-${name}-${runId}`;
  const downloadDir = `/tmp/webblackbox-${name}-downloads-${runId}`;
  const chromeLogPath = process.env.WB_E2E_LOG ?? `/tmp/webblackbox-${name}-${runId}.log`;
  const baseUrl = `http://127.0.0.1:${remotePort}`;
  const state = { chrome: null, logStream: null, servers: [], clients: [] };

  /** Starts Chrome and connects to it, its service worker, the page and the popup. */
  async function launch(pageUrl) {
    await access(resolve(extensionDir, "manifest.json"), constants.R_OK);
    await rm(profileDir, { recursive: true, force: true });
    await mkdir(profileDir, { recursive: true });
    await mkdir(downloadDir, { recursive: true });
    startChrome(await resolveChromeBinary());

    const version = await waitFor(
      () => fetchJson(`${baseUrl}/json/version`).then((v) => (v?.Browser ? v : null)),
      20_000,
      "Chrome DevTools endpoint not ready"
    );
    console.log(`Chrome: ${version.Browser}`);

    const browser = await connect(version.webSocketDebuggerUrl);
    await browser.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadDir,
      eventsEnabled: true
    });

    const swTarget = await waitFor(
      async () =>
        (await fetchJson(`${baseUrl}/json/list`)).find(
          (target) => target?.type === "service_worker" && target.url?.endsWith("/sw.js")
        ) ?? null,
      20_000,
      "Extension service worker not found"
    );
    const extensionId = /^chrome-extension:\/\/([^/]+)\//.exec(swTarget.url)?.[1];
    const sw = await connect(swTarget.webSocketDebuggerUrl);
    const swExceptions = [];
    await sw.send("Runtime.enable");
    sw.on("Runtime.exceptionThrown", (params) => {
      swExceptions.push(params?.exceptionDetails?.text ?? "unknown");
    });

    const page = await connect((await openTarget(pageUrl)).webSocketDebuggerUrl);
    const popup = await connect(
      (await openTarget(`chrome-extension://${extensionId}/popup.html`)).webSocketDebuggerUrl
    );
    await page.send("Runtime.enable");
    await popup.send("Runtime.enable");
    // An open dialog blocks every Runtime.evaluate on its page, so dialogs are accepted.
    const dialogs = [];
    await acceptDialogs(popup, dialogs);
    await acceptDialogs(page, dialogs);
    await sleep(1_000);

    return { page, popup, sw, swExceptions, dialogs, extensionId };
  }

  /** The exported archive's path once Chrome finished downloading it. */
  function waitForDownload() {
    return waitFor(
      async () => {
        const files = (await readdir(downloadDir)).filter((file) => !file.endsWith(".crdownload"));
        return files.length > 0 ? resolve(downloadDir, files[0]) : null;
      },
      30_000,
      "Exported archive was not downloaded"
    );
  }

  /** Opens another tab and connects to it; Runtime stays disabled so callers can subscribe first. */
  async function openPage(url) {
    const target = await openTarget(url);
    const client = await connect(target.webSocketDebuggerUrl);
    return { client, targetId: target.id };
  }

  async function closePage(targetId) {
    await fetch(`${baseUrl}/json/close/${targetId}`, { signal: AbortSignal.timeout(6_000) }).catch(
      () => undefined
    );
  }

  function trackServer(server) {
    state.servers.push(server);
  }

  function startChrome(binary) {
    const args = [
      `--remote-debugging-port=${remotePort}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-component-update",
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--enable-logging=stderr",
      "about:blank"
    ];

    if (headless) {
      args.unshift("--headless=new");
    }

    state.chrome = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    state.logStream = createWriteStream(chromeLogPath, { flags: "a" });
    state.chrome.stdout?.pipe(state.logStream);
    state.chrome.stderr?.pipe(state.logStream);
  }

  async function resolveChromeBinary() {
    for (const candidate of CHROME_CANDIDATES) {
      if (isAbsolute(candidate)) {
        try {
          await access(candidate, constants.X_OK);
          return candidate;
        } catch {
          continue;
        }
      }

      const which = spawnSync("which", [candidate], { encoding: "utf8" });

      if (which.status === 0 && which.stdout.trim()) {
        return which.stdout.trim().split("\n")[0];
      }
    }

    throw new Error("Chrome binary not found. Set WB_E2E_CHROME_BIN.");
  }

  async function acceptDialogs(client, log) {
    await client.send("Page.enable");
    client.on("Page.javascriptDialogOpening", (params) => {
      log.push(String(params?.message ?? "").slice(0, 120));
      void client.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => undefined);
    });
  }

  async function openTarget(url) {
    return fetchJson(`${baseUrl}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  }

  async function connect(wsUrl) {
    const client = new CdpClient(wsUrl);
    await client.connect();
    state.clients.push(client);
    return client;
  }

  async function cleanup() {
    for (const client of state.clients.splice(0)) {
      client.close();
    }

    state.chrome?.kill("SIGTERM");
    state.chrome = null;

    for (const server of state.servers.splice(0)) {
      server.close();
    }

    if (state.logStream) {
      await new Promise((resolveEnd) => state.logStream.end(resolveEnd));
      state.logStream = null;
    }
  }

  return { chromeLogPath, launch, openPage, closePage, waitForDownload, trackServer, cleanup };
}

export async function fetchJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(6_000) });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.json();
}

export async function waitFor(fn, timeoutMs, message) {
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

    await sleep(250);
  }

  throw new Error(lastError instanceof Error ? `${message}: ${lastError.message}` : message);
}

export function assert(condition, message, details) {
  if (!condition) {
    throw new Error(details === undefined ? message : `${message} | ${JSON.stringify(details)}`);
  }
}

export function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.sequence = 0;
    this.pending = new Map();
    this.handlers = new Map();
  }

  connect() {
    return new Promise((resolveOpen, reject) => {
      const socket = new WebSocket(this.wsUrl);
      this.socket = socket;
      socket.addEventListener("open", () => resolveOpen());
      socket.addEventListener("error", () => reject(new Error(`WebSocket failed: ${this.wsUrl}`)));
      socket.addEventListener("message", (event) => {
        const payload = JSON.parse(String(event.data));

        if (typeof payload.id === "number") {
          const pending = this.pending.get(payload.id);
          this.pending.delete(payload.id);

          if (payload.error) {
            pending?.reject(new Error(payload.error.message ?? "CDP error"));
          } else {
            pending?.resolve(payload.result);
          }

          return;
        }

        for (const handler of this.handlers.get(payload.method) ?? []) {
          handler(payload.params ?? {});
        }
      });
    });
  }

  on(method, handler) {
    this.handlers.set(method, [...(this.handlers.get(method) ?? []), handler]);
  }

  send(method, params = {}) {
    const id = ++this.sequence;

    return new Promise((resolveSend, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} did not answer within ${CDP_COMMAND_TIMEOUT_MS} ms`));
      }, CDP_COMMAND_TIMEOUT_MS);
      const settle = (callback) => (value) => {
        clearTimeout(timer);
        callback(value);
      };

      this.pending.set(id, { resolve: settle(resolveSend), reject: settle(reject) });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });

    if (result?.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      );
    }

    return result?.result?.value;
  }

  close() {
    this.socket?.close();
  }
}
