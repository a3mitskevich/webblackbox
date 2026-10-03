import type { NetworkWaterfallEntry } from "@webblackbox/player-sdk";

import { createPlayerI18n, type PlayerLocale } from "./i18n.js";

export function resolveNetworkSizeBytes(entry: NetworkWaterfallEntry): number {
  const size = entry.encodedDataLength ?? entry.responseBodySize;
  return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : -1;
}

export function formatNetworkSize(
  entry: NetworkWaterfallEntry,
  locale: PlayerLocale = "en"
): string {
  const size = resolveNetworkSizeBytes(entry);
  const i18n = createPlayerI18n(locale);

  if (!Number.isFinite(size) || size < 0) {
    return entry.failed ? i18n.messages.networkSizeFailed : "-";
  }

  return i18n.formatByteSize(size);
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
