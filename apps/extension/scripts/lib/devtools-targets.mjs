import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { CdpClient } from "./cdp-client.mjs";
import { fetchJson, formatErrorMessage, waitFor } from "./e2e-utils.mjs";

const DEVTOOLS_OPEN_TIMEOUT_MS = 6_000;
const DEVTOOLS_REQUEST_TIMEOUT_MS = 4_000;
const TARGET_POLL_INTERVAL_MS = 250;
const MAX_DEBUG_TARGETS = 12;
const MAX_DEBUG_URL_LENGTH = 120;

export async function openTarget(urlBase, url) {
  const target = await fetchJson(
    `${urlBase}/json/new?${encodeURIComponent(url)}`,
    DEVTOOLS_OPEN_TIMEOUT_MS,
    {
      method: "PUT"
    }
  );

  if (!target?.id || !target?.webSocketDebuggerUrl) {
    throw new Error(`Failed to open target: ${url}`);
  }

  return target;
}

export async function closeTarget(urlBase, targetId) {
  try {
    await fetchJson(`${urlBase}/json/close/${targetId}`, DEVTOOLS_REQUEST_TIMEOUT_MS);
  } catch {
    // ignored during cleanup
  }
}

/** Raw `/json/list` targets; throws when the DevTools endpoint is unreachable. */
export async function listHttpTargets(urlBase) {
  const targets = await fetchJson(`${urlBase}/json/list`, DEVTOOLS_REQUEST_TIMEOUT_MS);
  return Array.isArray(targets) ? targets : [];
}

/**
 * Merges `/json/list` with `Target.getTargets` from a browser-level client (which also sees
 * targets the HTTP list hides, e.g. some extension workers). Never throws.
 */
export async function listTargets(urlBase, browserClient) {
  const merged = new Map();
  const httpTargets = await listHttpTargets(urlBase).catch(() => []);

  for (const target of httpTargets) {
    const normalized = normalizeTargetDescriptor(target);
    merged.set(normalized.key, normalized);
  }

  if (browserClient) {
    const browserTargets = await browserClient
      .send("Target.getTargets")
      .then((result) => (Array.isArray(result?.targetInfos) ? result.targetInfos : []))
      .catch(() => []);

    for (const target of browserTargets) {
      const normalized = normalizeTargetDescriptor(target);
      const existing = merged.get(normalized.key);
      merged.set(normalized.key, {
        ...normalized,
        webSocketDebuggerUrl: existing?.webSocketDebuggerUrl ?? normalized.webSocketDebuggerUrl
      });
    }
  }

  return [...merged.values()];
}

export function normalizeTargetDescriptor(target) {
  const targetId =
    typeof target?.targetId === "string"
      ? target.targetId
      : typeof target?.id === "string"
        ? target.id
        : "";
  const url = typeof target?.url === "string" ? target.url : "";
  const type = typeof target?.type === "string" ? target.type : "unknown";
  const webSocketDebuggerUrl =
    typeof target?.webSocketDebuggerUrl === "string" ? target.webSocketDebuggerUrl : undefined;

  return {
    key: targetId || `${type}:${url}`,
    targetId,
    id: typeof target?.id === "string" ? target.id : targetId,
    type,
    url,
    title: typeof target?.title === "string" ? target.title : "",
    webSocketDebuggerUrl
  };
}

export function summarizeTargetsForDebug(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return "[]";
  }

  return targets
    .slice(0, MAX_DEBUG_TARGETS)
    .map((target) => {
      const type = typeof target?.type === "string" ? target.type : "unknown";
      const url = typeof target?.url === "string" ? target.url : "";
      const normalizedUrl =
        url.length > MAX_DEBUG_URL_LENGTH ? `${url.slice(0, MAX_DEBUG_URL_LENGTH - 3)}...` : url;
      return `${type}:${normalizedUrl}`;
    })
    .join(", ");
}

/** Polls `listTargets` until `matcher` finds a target; the failure lists the targets seen last. */
export async function waitForExtensionTarget(
  urlBase,
  browserClient,
  matcher,
  timeoutMs,
  timeoutMessage
) {
  let lastSummary = "none";

  try {
    return await waitFor(
      async () => {
        const targets = await listTargets(urlBase, browserClient);
        lastSummary = summarizeTargetsForDebug(targets);
        return targets.find(matcher) ?? null;
      },
      timeoutMs,
      TARGET_POLL_INTERVAL_MS,
      timeoutMessage
    );
  } catch (error) {
    throw new Error(`${timeoutMessage}. Targets: ${lastSummary}. ${formatErrorMessage(error)}`);
  }
}

/**
 * Connects straight to the target's WebSocket when DevTools exposes one, otherwise attaches a
 * flat session through the browser-level client.
 */
export async function connectToDiscoveredTarget(target, browserClient, clientOptions = {}) {
  if (target.webSocketDebuggerUrl) {
    const client = new CdpClient(target.webSocketDebuggerUrl, clientOptions);
    await client.connect();
    return client;
  }

  if (!browserClient || !target.targetId) {
    throw new Error(`Target is not directly debuggable: ${target.url || target.type}`);
  }

  return browserClient.attachToTarget(target.targetId);
}

export function extractExtensionId(url) {
  const match = /^chrome-extension:\/\/([^/]+)\//.exec(url);

  if (!match) {
    throw new Error(`Failed to parse extension id from target URL: ${url}`);
  }

  return match[1];
}

export function isLikelyExtensionId(value) {
  return typeof value === "string" && /^[a-p]{32}$/.test(value);
}

/** Chrome derives unpacked-extension ids from the SHA-256 of the manifest public key. */
export function computeExtensionIdFromManifestKey(keyBase64) {
  const digest = createHash("sha256").update(Buffer.from(keyBase64, "base64")).digest();
  const alphabet = "abcdefghijklmnop";
  let id = "";

  for (let index = 0; index < 16; index += 1) {
    const value = digest[index];
    id += alphabet[(value >> 4) & 0x0f];
    id += alphabet[value & 0x0f];
  }

  return id;
}

/**
 * Expected extension id: `WB_E2E_EXTENSION_ID` when set, else derived from the build
 * manifest `key`. Returns null when it cannot be determined.
 */
export async function resolvePreferredExtensionId(extensionDir) {
  const fromEnv = process.env.WB_E2E_EXTENSION_ID?.trim();

  if (isLikelyExtensionId(fromEnv)) {
    return fromEnv;
  }

  let manifest;

  try {
    manifest = JSON.parse(await readFile(resolve(extensionDir, "manifest.json"), "utf8"));
  } catch {
    return null;
  }

  const key = typeof manifest?.key === "string" ? manifest.key.trim() : "";

  if (key.length === 0) {
    return null;
  }

  try {
    const id = computeExtensionIdFromManifestKey(key);
    return isLikelyExtensionId(id) ? id : null;
  } catch {
    return null;
  }
}
