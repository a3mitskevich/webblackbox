import type { WebBlackboxPlayer } from "@webblackbox/player-sdk";

import type { PlayerLocale } from "../../../lib/i18n.js";
import {
  isTrustedShareOrigin,
  normalizeShareServerBaseUrl,
  resolveShareArchiveRequest,
  type ShareArchiveRequest
} from "../../../lib/share.js";
import {
  getShareServerApiKeyForBaseUrl,
  setShareServerApiKeyForBaseUrl
} from "../../../lib/share-api-key.js";
import {
  DEFAULT_SHARE_SERVER_BASE_URL,
  persistShareServerApiKeys,
  readStoredShareServerApiKeys,
  readStoredShareServerBaseUrl,
  storeShareServerBaseUrl
} from "../../../lib/share-settings.js";
import {
  buildClientShareSummary,
  encodeShareSummaryHeader,
  SHARE_SUMMARY_HEADER
} from "../../../lib/share-summary.js";
import { uploadArchiveWithProgress } from "../../../lib/share-upload.js";
import type { PlayerController } from "../../controller.js";
import { shareSlice } from "./slice.js";

/** Share-server settings kept in localStorage (the classic player's keys). */
export type ShareSettingsStore = {
  readBaseUrl(): string;
  readApiKeys(baseUrl: string): Record<string, string>;
  /** Saves the server and its key (an empty key never removes a saved one). */
  remember(baseUrl: string, apiKey: string): void;
};

export const browserShareSettings: ShareSettingsStore = {
  readBaseUrl: readStoredShareServerBaseUrl,
  readApiKeys: readStoredShareServerApiKeys,
  remember(baseUrl, apiKey) {
    storeShareServerBaseUrl(baseUrl);
    persistShareServerApiKeys(
      setShareServerApiKeyForBaseUrl(readStoredShareServerApiKeys(baseUrl), baseUrl, apiKey)
    );
  }
};

/** The saved API key for a server URL being typed (`""` for unknown or invalid URLs). */
export function apiKeyFor(settings: ShareSettingsStore, baseUrl: string): string {
  const normalized = normalizeHttpServer(baseUrl);
  return normalized
    ? getShareServerApiKeyForBaseUrl(settings.readApiKeys(normalized), normalized)
    : "";
}

/** The origin of an http(s) share server URL; `null` for anything else (`javascript:`, …). */
export function normalizeHttpServer(value: string): string | null {
  const origin = normalizeShareServerBaseUrl(value);
  return origin && /^https?:\/\//u.test(origin) ? origin : null;
}

export class ShareError extends Error {
  public readonly code: "invalid-server" | "invalid-reference" | "missing-url" | "request";

  public constructor(code: ShareError["code"], message: string) {
    super(message);
    this.name = "ShareError";
    this.code = code;
  }
}

export type UploadProgress = { loaded: number; total: number };

export type UploadOptions = {
  baseUrl: string;
  apiKey: string;
  fileName: string;
  bytes: Uint8Array;
  player: WebBlackboxPlayer;
  locale: PlayerLocale;
  onProgress: (progress: UploadProgress) => void;
  settings?: ShareSettingsStore;
  upload?: typeof uploadArchiveWithProgress;
};

/**
 * Uploads the archive as it was opened (still encrypted when it was) with the client share
 * summary header, remembers the server and key, and returns the share URL.
 */
export async function uploadArchive(options: UploadOptions): Promise<string> {
  const baseUrl = normalizeHttpServer(options.baseUrl);

  if (!baseUrl) {
    throw new ShareError("invalid-server", options.baseUrl);
  }

  const apiKey = options.apiKey.trim();
  (options.settings ?? browserShareSettings).remember(baseUrl, apiKey);
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "x-webblackbox-filename": options.fileName,
    [SHARE_SUMMARY_HEADER]: encodeShareSummaryHeader(buildClientShareSummary(options.player)),
    ...(apiKey ? { "x-webblackbox-api-key": apiKey } : {})
  };
  const body = options.bytes.slice().buffer;
  const payload = await (options.upload ?? uploadArchiveWithProgress)(
    `${baseUrl}/api/share/upload`,
    headers,
    body,
    (loaded, total) =>
      options.onProgress({ loaded, total: total && total > 0 ? total : body.byteLength }),
    options.locale
  );
  const shareId = typeof payload.shareId === "string" && payload.shareId ? payload.shareId : null;
  const shareUrl =
    typeof payload.shareUrl === "string" && payload.shareUrl
      ? payload.shareUrl
      : shareId
        ? `${baseUrl}/share/${shareId}`
        : null;

  if (!shareUrl) {
    throw new ShareError("missing-url", JSON.stringify(payload).slice(0, 200));
  }

  return shareUrl;
}

export type SharedArchive = { bytes: Uint8Array; request: ShareArchiveRequest };

type FetchLike = (
  input: string,
  init: { headers: Record<string, string> }
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** Downloads a shared archive by share URL or id (`persist` saves the server and key). */
export async function fetchSharedArchive(options: {
  reference: string;
  apiKey: string;
  persist: boolean;
  settings?: ShareSettingsStore;
  fetch?: FetchLike;
}): Promise<SharedArchive> {
  const settings = options.settings ?? browserShareSettings;
  const request = resolveShareArchiveRequest(options.reference.trim(), settings.readBaseUrl());

  if (!request) {
    throw new ShareError("invalid-reference", options.reference);
  }

  const apiKey = options.apiKey.trim();

  if (options.persist) {
    settings.remember(request.baseUrl, apiKey);
  }

  const response = await (options.fetch ?? (globalThis.fetch as unknown as FetchLike))(
    request.archiveUrl,
    { headers: apiKey ? { "x-webblackbox-api-key": apiKey } : {} }
  );

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new ShareError("request", message || `HTTP ${response.status}`);
  }

  return { bytes: new Uint8Array(await response.arrayBuffer()), request };
}

/** What to do with a `?share=` link on load. */
export type ShareLinkDecision =
  | { kind: "none" }
  | { kind: "invalid"; reference: string }
  | { kind: "trusted"; reference: string; apiKey: string }
  | { kind: "confirm"; reference: string; origin: string };

/**
 * A `?share=` link is attacker-controllable: it never changes the saved server or keys, and an
 * archive from an origin other than this page, the default or the saved server loads only after
 * the user confirms it (the classic player's rule).
 */
export function decideShareLink(
  href: string,
  pageOrigin: string,
  settings: ShareSettingsStore = browserShareSettings
): ShareLinkDecision {
  let reference: string;

  try {
    reference = new URL(href).searchParams.get("share")?.trim() ?? "";
  } catch {
    return { kind: "none" };
  }

  if (!reference) {
    return { kind: "none" };
  }

  const savedBaseUrl = settings.readBaseUrl();
  const request = resolveShareArchiveRequest(reference, savedBaseUrl);

  if (!request) {
    return { kind: "invalid", reference };
  }

  if (
    isTrustedShareOrigin(request.baseUrl, [pageOrigin, DEFAULT_SHARE_SERVER_BASE_URL, savedBaseUrl])
  ) {
    return {
      kind: "trusted",
      reference,
      apiKey: getShareServerApiKeyForBaseUrl(settings.readApiKeys(savedBaseUrl), request.baseUrl)
    };
  }

  return { kind: "confirm", reference, origin: request.baseUrl };
}

export type LoadSharedOptions = {
  reference: string;
  apiKey: string;
  persist: boolean;
  messages: { failed: (error: string) => string; invalid: string };
  settings?: ShareSettingsStore;
  fetch?: FetchLike;
};

/**
 * Downloads a shared recording and opens it like a file (an encrypted one asks for its
 * passphrase in the player's dialog). Progress and failures land in the share slice.
 */
export async function loadSharedArchive(
  controller: PlayerController,
  options: LoadSharedOptions
): Promise<boolean> {
  const { store } = controller;
  shareSlice.update(store, (slice) => ({ ...slice, open: { phase: "loading" } }));

  try {
    const { bytes, request } = await fetchSharedArchive(options);
    shareSlice.update(store, (slice) => ({ ...slice, dialog: null, open: { phase: "idle" } }));
    await controller.openFile({
      name: `shared-${request.shareId}.webblackbox`,
      arrayBuffer: async () => bytes.slice().buffer
    });
    return true;
  } catch (error) {
    const message =
      error instanceof ShareError && error.code === "invalid-reference"
        ? options.messages.invalid
        : options.messages.failed(error instanceof Error ? error.message : String(error));
    shareSlice.update(store, (slice) => ({ ...slice, open: { phase: "error", message } }));
    store.setState((state) => ({ ...state, announcement: message }));
    return false;
  }
}
