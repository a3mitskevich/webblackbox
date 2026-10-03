import { spawn, spawnSync } from "node:child_process";
import { constants, createWriteStream } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { isAbsolute, resolve } from "node:path";

import { fetchJson, formatErrorMessage, readLogTail, sleep, waitFor } from "./e2e-utils.mjs";

export const DEFAULT_CHROME_CANDIDATES = [
  process.env.WB_E2E_CHROME_BIN,
  "/Users/unadlib/Library/Caches/ms-playwright/chromium-1212/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
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

const TERMINATE_GRACE_MS = 5_000;
const KILL_GRACE_MS = 2_000;
const DEVTOOLS_POLL_INTERVAL_MS = 250;
const DEVTOOLS_REQUEST_TIMEOUT_MS = 4_000;
const LOG_TAIL_LINES = 40;

export async function ensureExtensionBuildReady(dir) {
  await access(dir, constants.R_OK);
  await access(resolve(dir, "manifest.json"), constants.R_OK);
  await access(resolve(dir, "sw.js"), constants.R_OK);
}

export async function resolveChromeBinary(candidates = DEFAULT_CHROME_CANDIDATES) {
  for (const candidate of candidates) {
    const resolved = await resolveChromeCandidate(candidate);

    if (resolved) {
      return resolved;
    }
  }

  throw new Error(
    "Chrome binary not found. Set WB_E2E_CHROME_BIN or install Chrome for Testing/Google Chrome."
  );
}

async function resolveChromeCandidate(candidate) {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    return null;
  }

  const trimmed = candidate.trim();

  if (isAbsolute(trimmed) || trimmed.startsWith(".")) {
    return (await isExecutable(trimmed)) ? trimmed : null;
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

  return resolved && (await isExecutable(resolved)) ? resolved : null;
}

async function isExecutable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the Chrome argv for an extension e2e run.
 *
 * @param {object} options
 * @param {number} options.remotePort
 * @param {string} options.profileDir
 * @param {string} options.extensionDir
 * @param {boolean} options.headless
 * @param {string[]} [options.extraArgs] script-specific switches
 * @param {boolean} [options.disableLinuxSandbox] add --no-sandbox & co. on Linux (CI containers)
 */
export function buildChromeArgs(options) {
  const args = [
    `--remote-debugging-port=${options.remotePort}`,
    `--user-data-dir=${options.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-component-update",
    "--disable-default-apps",
    ...(options.extraArgs ?? []),
    `--disable-extensions-except=${options.extensionDir}`,
    `--load-extension=${options.extensionDir}`,
    "--enable-logging=stderr",
    "--v=1",
    "about:blank"
  ];

  const prefix = [
    ...(options.disableLinuxSandbox && process.platform === "linux"
      ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
      : []),
    ...(options.headless ? ["--headless=new"] : [])
  ];

  return [...prefix, ...args];
}

/**
 * Spawns Chrome with stdout/stderr piped into `options.logPath`.
 * Accepts every `buildChromeArgs` option plus `logPath` and `warnOnExit`.
 */
export function startChrome(binary, options) {
  const proc = spawn(binary, buildChromeArgs(options), {
    stdio: ["ignore", "pipe", "pipe"]
  });

  const logStream = createWriteStream(options.logPath, { flags: "a" });
  proc.stdout?.pipe(logStream);
  proc.stderr?.pipe(logStream);

  if (options.warnOnExit) {
    proc.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        console.warn(`Chrome exited with code ${code}.`);
      }

      if (signal) {
        console.warn(`Chrome exited via signal ${signal}.`);
      }
    });
  }

  return { proc, logStream };
}

/**
 * Waits for the DevTools HTTP endpoint. With `context.proc`, fails fast if Chrome exits first;
 * with `context.logPath`, appends the Chrome log tail to the failure message.
 */
export async function waitForChromeReady(urlBase, timeoutMs, context = undefined) {
  try {
    return await waitFor(
      async () => {
        assertChromeStillRunning(context?.proc);
        const version = await fetchJson(`${urlBase}/json/version`, DEVTOOLS_REQUEST_TIMEOUT_MS);
        return version?.Browser ? version : null;
      },
      timeoutMs,
      DEVTOOLS_POLL_INTERVAL_MS,
      `Chrome DevTools endpoint not ready at ${urlBase}`
    );
  } catch (error) {
    const logTail = context?.logPath
      ? await readLogTail(context.logPath, LOG_TAIL_LINES).catch(() => "")
      : "";
    const suffix = logTail ? `\nChrome log tail:\n${logTail}` : "";
    throw new Error(`${formatErrorMessage(error)}${suffix}`);
  }
}

function assertChromeStillRunning(proc) {
  if (proc?.exitCode !== null && proc?.exitCode !== undefined) {
    throw new Error(`Chrome exited before DevTools was ready (exitCode=${proc.exitCode}).`);
  }

  if (proc?.signalCode) {
    throw new Error(`Chrome exited before DevTools was ready (signalCode=${proc.signalCode}).`);
  }
}

/**
 * Launches Chrome, retrying on a fresh profile and an ephemeral port when DevTools does not
 * come up. `options.chrome` is forwarded to `startChrome` (extraArgs, disableLinuxSandbox, …).
 */
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

    const launchPort =
      attempt === 1 ? await resolveLaunchPort(options.remotePort) : await reserveEphemeralPort();
    const baseUrl = `http://127.0.0.1:${launchPort}`;
    const { proc, logStream } = startChrome(binary, {
      ...options.chrome,
      extensionDir: options.extensionDir,
      profileDir: attemptProfileDir,
      remotePort: launchPort,
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
        remotePort: launchPort,
        profileDir: attemptProfileDir,
        version
      };
    } catch (error) {
      lastError = error;
      await terminateChromeProcess(proc);
      logStream.end();

      if (attempt < options.attempts) {
        console.warn(
          `Chrome launch attempt ${attempt}/${options.attempts} failed; retrying on a fresh profile. ${formatErrorMessage(error)}`
        );
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** SIGTERM, then SIGKILL; every step is bounded so cleanup never hangs. */
export async function terminateChromeProcess(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
    return;
  }

  proc.kill("SIGTERM");
  await waitForExit(proc, TERMINATE_GRACE_MS);

  if (proc.exitCode === null && proc.signalCode === null) {
    proc.kill("SIGKILL");
    await waitForExit(proc, KILL_GRACE_MS);
  }
}

function waitForExit(proc, timeoutMs) {
  return Promise.race([
    new Promise((resolve) => {
      proc.once("exit", resolve);
    }),
    sleep(timeoutMs)
  ]);
}

export async function resolveLaunchPort(preferredPort) {
  if (Number.isFinite(preferredPort) && preferredPort > 0) {
    const preferredAvailable = await canBindPort(preferredPort);
    if (preferredAvailable) {
      return preferredPort;
    }
  }

  return reserveEphemeralPort();
}

export async function canBindPort(port) {
  const server = createNetServer();

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) {
      await new Promise((resolve) => {
        server.close(() => resolve());
      }).catch(() => undefined);
    }
  }
}

export async function reserveEphemeralPort() {
  const server = createNetServer();

  try {
    return await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to reserve an ephemeral port."));
          return;
        }
        resolve(address.port);
      });
    });
  } finally {
    await new Promise((resolve) => {
      server.close(() => resolve());
    }).catch(() => undefined);
  }
}
