import { readFile } from "node:fs/promises";

// Extra time a single waitFor attempt may run past the overall deadline before it is abandoned.
// Keeps slow-but-progressing attempts working while guaranteeing the wait itself is bounded.
const WAIT_FOR_ATTEMPT_GRACE_MS = 5_000;

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function assert(condition, message, details) {
  if (condition) {
    return;
  }

  const suffix = details === undefined ? "" : ` | details=${JSON.stringify(details)}`;
  throw new Error(`${message}${suffix}`);
}

export function readPositiveInteger(value, fallback) {
  const numeric = Number(value ?? fallback);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

export function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Rejects with `message` when `promise` does not settle within `timeoutMs`.
 * The underlying promise is not cancelled; callers own its cleanup.
 */
export async function withTimeout(promise, timeoutMs, message) {
  let timer = null;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Polls `fn` until it returns a non-nullish value. Errors thrown by `fn` are retried and the
 * last one is reported on timeout. Each attempt is itself bounded, so a hung attempt cannot
 * stall the caller past `timeoutMs + WAIT_FOR_ATTEMPT_GRACE_MS`.
 *
 * `timeoutMessage` may be a string or a function evaluated lazily at timeout.
 */
export async function waitFor(fn, timeoutMs, intervalMs, timeoutMessage) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const attemptBudgetMs = deadline - Date.now() + WAIT_FOR_ATTEMPT_GRACE_MS;
      const result = await withTimeout(
        Promise.resolve().then(fn),
        attemptBudgetMs,
        `attempt did not settle within ${attemptBudgetMs}ms`
      );

      if (result !== null && result !== undefined) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(intervalMs);
  }

  const message = typeof timeoutMessage === "function" ? timeoutMessage() : timeoutMessage;
  const elapsed = `timed out after ${Date.now() - startedAt}ms`;

  if (lastError instanceof Error) {
    throw new Error(`${message} (${elapsed}): ${lastError.message}`);
  }

  throw new Error(`${message} (${elapsed})`);
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

export async function readLogTail(path, maxLines) {
  const content = await readFile(path, "utf8");
  const lines = content
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  return lines.slice(-maxLines).join("\n");
}
