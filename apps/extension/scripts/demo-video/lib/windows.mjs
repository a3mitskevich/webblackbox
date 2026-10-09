// WSL -> Windows bridge: paths, the PowerShell agent (input + UI Automation) and the abort
// watchdog. Everything that touches the owner's desktop goes through here.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WIN_HELPERS_DIR = join(HERE, "..", "win");
const POWERSHELL = "powershell.exe";
const AGENT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

export class AbortedError extends Error {
  constructor(reason) {
    super(`take aborted by the owner (${reason})`);
    this.name = "AbortedError";
  }
}

export function toWslPath(winPath) {
  return execFileSync("wslpath", ["-u", winPath], { encoding: "utf8" }).trim();
}

export function toWinPath(wslPath) {
  return execFileSync("wslpath", ["-w", wslPath], { encoding: "utf8" }).trim();
}

/** JSON with every non-ASCII character escaped, so PowerShell's stdin code page cannot mangle it. */
export function asciiJson(value) {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/gu,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

/** Copies the PowerShell/C# helpers next to the take files (PowerShell does not run them from \\wsl$). */
export function installHelpers(workDirWsl) {
  const binWsl = join(workDirWsl, "bin");
  mkdirSync(binWsl, { recursive: true });
  cpSync(WIN_HELPERS_DIR, binWsl, { recursive: true });
  return toWinPath(join(binWsl, "agent.ps1"));
}

function spawnHelper(scriptWin, mode) {
  return spawn(
    POWERSHELL,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptWin, "-Mode", mode],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
}

/**
 * Starts the input agent. `call(cmd, params)` resolves with the command's result; a command the
 * owner aborted rejects with AbortedError.
 */
export async function startAgent(scriptWin, log = () => undefined) {
  const child = spawnHelper(scriptWin, "agent");
  const pending = new Map();
  let sequence = 0;
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`agent did not start: ${stderr}`)),
      AGENT_READY_TIMEOUT_MS
    );
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`agent exited (${code}): ${stderr}`));
    });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        log(`agent: ${line}`);
        return;
      }
      if (message.ready) {
        clearTimeout(timer);
        resolve();
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.result ?? null);
      else if (message.aborted) entry.reject(new AbortedError("agent"));
      else entry.reject(new Error(`agent ${entry.cmd}: ${message.error}`));
    });
  });
  child.on("exit", () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`agent exited during ${entry.cmd}`));
    }
    pending.clear();
  });
  await ready;

  function call(cmd, params = {}, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`agent ${cmd} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { cmd, resolve, reject, timer });
      child.stdin.write(`${asciiJson({ id, cmd, ...params })}\n`);
    });
  }

  async function close() {
    child.stdin.end();
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", resolve);
      setTimeout(resolve, 5000).unref();
    });
  }

  return { call, close };
}

/** Starts the abort watchdog; `onAbort(reason)` fires once on Escape or a screen corner. */
export async function startWatchdog(scriptWin, onAbort) {
  const child = spawnHelper(scriptWin, "watchdog");
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`watchdog did not start: ${stderr}`)),
      AGENT_READY_TIMEOUT_MS
    );
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`watchdog exited (${code}): ${stderr}`));
    });
    lines.on("line", (line) => {
      if (line.trim() === "READY") {
        clearTimeout(timer);
        resolve();
      } else if (line.startsWith("ABORT")) {
        onAbort(line.slice("ABORT".length).trim() || "unknown");
      }
    });
  });
  return {
    close() {
      child.stdin.end();
      child.kill();
    }
  };
}

/** Windows PIDs of the processes whose command line contains `needle` (e.g. the demo profile). */
export function findWindowsPids(imageName, needle) {
  const filter = `Name='${imageName.replace(/'/gu, "")}'`;
  const script = [
    `$n = '${needle.replace(/'/gu, "''")}'`,
    `Get-CimInstance Win32_Process -Filter "${filter}" |`,
    `  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($n) } |`,
    `  ForEach-Object { $_.ProcessId }`
  ].join("\n");
  const out = execFileSync(POWERSHELL, ["-NoProfile", "-Command", script], { encoding: "utf8" });
  return out
    .split(/\r?\n/u)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** Windows PIDs of every process with the given image name (e.g. explorer.exe). */
export function findPidsByImage(imageName) {
  const script = `Get-Process -Name '${imageName.replace(/\.exe$/u, "").replace(/'/gu, "")}' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }`;
  const out = execFileSync(POWERSHELL, ["-NoProfile", "-Command", script], { encoding: "utf8" });
  return out
    .split(/\r?\n/u)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** Runs a short PowerShell snippet (setup and cleanup only, never during a take's input). */
export function powershell(script) {
  return execFileSync(POWERSHELL, ["-NoProfile", "-Command", script], { encoding: "utf8" });
}
