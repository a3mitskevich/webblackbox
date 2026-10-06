import { extractRequestIdFromPayload, type WebBlackboxEventType } from "@webblackbox/protocol";

import { asRecord, asString } from "./normalizer-utils.js";

/**
 * Schemes of extension and browser-internal resources. They are never the recorded app's
 * traffic: the page loads this extension's own content scripts (about 1 MiB) and other
 * extensions' scripts this way, and they only clutter the waterfall.
 */
const BROWSER_INTERNAL_URL_SCHEMES = new Set([
  "chrome-extension",
  "moz-extension",
  "safari-web-extension",
  "chrome",
  "chrome-untrusted",
  "chrome-search",
  "devtools",
  "edge"
]);

/**
 * Most filtered request ids remembered; the oldest go first. Ids stay after the request ends
 * because host records (a body or a skip) can follow its last network event.
 */
export const MAX_TRACKED_INTERNAL_REQUESTS = 4096;

export function isBrowserInternalUrl(url: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim())?.[1]?.toLowerCase();
  return scheme !== undefined && BROWSER_INTERNAL_URL_SCHEMES.has(scheme);
}

/**
 * Drops network events of extension and browser-internal URLs. The URL only shows on the first
 * event of a request (request, WebSocket open, or a response seen without its request), so the
 * request id is remembered for its later events.
 */
export class BrowserInternalNetworkFilter {
  private readonly filteredRequestIds = new Set<string>();

  public shouldDrop(eventType: WebBlackboxEventType, payload: unknown): boolean {
    if (!eventType.startsWith("network.")) {
      return false;
    }

    const reqId = extractRequestIdFromPayload(payload);

    if (reqId && this.filteredRequestIds.has(reqId)) {
      return true;
    }

    const url = readNetworkUrl(payload);

    if (!url || !isBrowserInternalUrl(url)) {
      return false;
    }

    if (reqId) {
      this.remember(reqId);
    }

    return true;
  }

  private remember(reqId: string): void {
    if (this.filteredRequestIds.size >= MAX_TRACKED_INTERNAL_REQUESTS) {
      const oldest = this.filteredRequestIds.values().next().value;

      if (oldest !== undefined) {
        this.filteredRequestIds.delete(oldest);
      }
    }

    this.filteredRequestIds.add(reqId);
  }
}

function readNetworkUrl(payload: unknown): string | undefined {
  const row = asRecord(payload);

  return (
    asString(asRecord(row?.request)?.url) ??
    asString(asRecord(row?.response)?.url) ??
    asString(row?.url)
  );
}
