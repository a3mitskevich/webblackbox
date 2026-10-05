import type { NetworkWaterfallEntry } from "@webblackbox/player-sdk";

import { createPlayerI18n, type PlayerLocale } from "./i18n.js";

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function resolveNetworkSizeBytes(entry: NetworkWaterfallEntry): number {
  const size = entry.encodedDataLength ?? entry.responseBodySize;
  return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : -1;
}

export function formatNetworkSize(
  entry: NetworkWaterfallEntry,
  locale: PlayerLocale = "en"
): string {
  if (entry.fromCache) {
    // Like DevTools: a cache hit transfers nothing, so name the cache instead of a byte count.
    return createPlayerI18n(locale).messages.networkCacheSources[entry.fromCache];
  }

  const size = resolveNetworkSizeBytes(entry);

  if (!Number.isFinite(size) || size < 0) {
    return entry.failed ? "(failed)" : "-";
  }

  return formatByteSize(size);
}

export function sumNetworkTransferBytes(entries: NetworkWaterfallEntry[]): number {
  let total = 0;

  for (const entry of entries) {
    const bytes = resolveNetworkSizeBytes(entry);

    if (bytes > 0) {
      total += bytes;
    }
  }

  return total;
}
