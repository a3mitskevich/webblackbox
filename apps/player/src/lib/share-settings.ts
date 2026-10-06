import { asRecord } from "./parsing.js";
import { resolveShareServerOrigin } from "./share.js";
import { readStoredText, removeStoredItem, writeStoredText } from "./storage.js";

export const SHARE_SERVER_BASE_URL_STORAGE_KEY = "webblackbox.player.shareServerBaseUrl";
export const SHARE_SERVER_API_KEYS_STORAGE_KEY = "webblackbox.player.shareServerApiKeysByOrigin";
const LEGACY_SHARE_SERVER_API_KEY_STORAGE_KEY = "webblackbox.player.shareServerApiKey";
export const DEFAULT_SHARE_SERVER_BASE_URL = "http://localhost:8787";

/** The share server last used (or the default local one). */
export function readStoredShareServerBaseUrl(): string {
  return readStoredText(SHARE_SERVER_BASE_URL_STORAGE_KEY) ?? DEFAULT_SHARE_SERVER_BASE_URL;
}

export function storeShareServerBaseUrl(baseUrl: string): void {
  writeStoredText(SHARE_SERVER_BASE_URL_STORAGE_KEY, baseUrl);
}

/** Saved API keys by share-server origin; a legacy single key moves to the given server. */
export function readStoredShareServerApiKeys(baseUrl: string): Record<string, string> {
  const parsed = parseStoredShareServerApiKeys(readStoredText(SHARE_SERVER_API_KEYS_STORAGE_KEY));
  const legacyApiKey = readStoredText(LEGACY_SHARE_SERVER_API_KEY_STORAGE_KEY);

  if (legacyApiKey) {
    const origin = resolveShareServerOrigin(baseUrl);

    if (origin && !parsed[origin]) {
      parsed[origin] = legacyApiKey;
    }

    removeStoredItem(LEGACY_SHARE_SERVER_API_KEY_STORAGE_KEY);
    persistShareServerApiKeys(parsed);
  }

  return parsed;
}

function parseStoredShareServerApiKeys(raw: string | null): Record<string, string> {
  if (!raw) {
    return {};
  }

  try {
    const candidate = asRecord(JSON.parse(raw));

    if (!candidate) {
      return {};
    }

    const parsed: Record<string, string> = {};

    for (const [originCandidate, apiKeyCandidate] of Object.entries(candidate)) {
      if (typeof apiKeyCandidate !== "string") {
        continue;
      }

      const origin = resolveShareServerOrigin(originCandidate);
      const apiKey = apiKeyCandidate.trim();

      if (!origin || apiKey.length === 0) {
        continue;
      }

      parsed[origin] = apiKey;
    }

    return parsed;
  } catch {
    removeStoredItem(SHARE_SERVER_API_KEYS_STORAGE_KEY);
    return {};
  }
}

/** Saves the API keys by origin (invalid entries are dropped). */
export function persistShareServerApiKeys(apiKeysByOrigin: Record<string, string>): void {
  const entries: Array<{ origin: string; apiKey: string }> = [];

  for (const [originCandidate, apiKeyCandidate] of Object.entries(apiKeysByOrigin)) {
    const origin = resolveShareServerOrigin(originCandidate);
    const apiKey = apiKeyCandidate.trim();

    if (!origin || apiKey.length === 0) {
      continue;
    }

    entries.push({
      origin,
      apiKey
    });
  }

  entries.sort((left, right) => left.origin.localeCompare(right.origin));

  if (entries.length === 0) {
    removeStoredItem(SHARE_SERVER_API_KEYS_STORAGE_KEY);
    return;
  }

  const serialized: Record<string, string> = {};

  for (const entry of entries) {
    serialized[entry.origin] = entry.apiKey;
  }

  writeStoredText(SHARE_SERVER_API_KEYS_STORAGE_KEY, JSON.stringify(serialized));
}
