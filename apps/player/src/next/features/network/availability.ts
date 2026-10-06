import type { NetworkBodySkip, NetworkWaterfallEntry } from "@webblackbox/player-sdk";

import type { NetworkTranslator } from "./messages.js";

/**
 * What the archive holds for one body of a request (PR #21 "not captured" data):
 * - `captured`: the body is in the archive (maybe cut at the profile limit);
 * - `skipped`: the capture asked for it and recorded why it is missing;
 * - `missing`: it should be there and the archive does not say why (older recordings);
 * - `none`: there is no body to keep (failed request, redirect, no content, GET without body).
 */
export type BodyAvailability =
  | { state: "captured"; truncated: boolean }
  | { state: "skipped"; skip: NetworkBodySkip }
  | { state: "missing" }
  | { state: "none" };

const NO_BODY_STATUSES = new Set([204, 205, 304]);

export function responseBodyAvailability(entry: NetworkWaterfallEntry): BodyAvailability {
  if (entry.responseBodyHash) {
    return { state: "captured", truncated: entry.responseBodyTruncated === true };
  }

  if (entry.responseBodySkip) {
    return { state: "skipped", skip: entry.responseBodySkip };
  }

  const status = entry.status;
  const hasNoBody =
    entry.failed ||
    entry.pending === true ||
    entry.method.toUpperCase() === "HEAD" ||
    typeof status !== "number" ||
    status < 200 ||
    (status >= 300 && status < 400) ||
    NO_BODY_STATUSES.has(status);

  return hasNoBody ? { state: "none" } : { state: "missing" };
}

export function requestBodyAvailability(entry: NetworkWaterfallEntry): BodyAvailability {
  if (entry.requestBodyText !== undefined) {
    return { state: "captured", truncated: entry.requestBodyTruncated === true };
  }

  if (entry.requestBodySkipReason) {
    return { state: "skipped", skip: { reason: entry.requestBodySkipReason } };
  }

  return entry.requestHasBody ? { state: "missing" } : { state: "none" };
}

/** "too large (5.0 MB, limit 1.0 MB)", "the browser no longer held the body", … */
export function skipReasonText(
  skip: NetworkBodySkip,
  t: NetworkTranslator,
  formatBytes: (bytes: number) => string,
  mime?: string
): string {
  switch (skip.reason) {
    case "filtered":
      return t("reason_filtered");
    case "mime-not-allowed":
      return t("reason_mimeNotAllowed", { mime: mime || t("thisType") });
    case "too-large":
      return skip.size !== undefined && skip.limit !== undefined
        ? t("reason_tooLarge", { size: formatBytes(skip.size), limit: formatBytes(skip.limit) })
        : t("reason_tooLargePlain");
    case "session-limit":
      return t("reason_sessionLimit");
    case "backlog":
      return t("reason_backlog");
    case "not-retained":
      return t("reason_notRetained");
    case "unavailable":
      return t("reason_unavailable");
    case "fetch-failed":
      return t("reason_fetchFailed", { detail: skip.detail ?? "—" });
    case "empty":
      return t("reason_empty");
  }
}

/** The table marker's tooltip for a row whose body was not captured, or `null`. */
export function notCapturedSummary(
  entry: NetworkWaterfallEntry,
  t: NetworkTranslator,
  formatBytes: (bytes: number) => string
): string | null {
  const response = responseBodyAvailability(entry);
  const request = requestBodyAvailability(entry);
  const skip =
    response.state === "skipped"
      ? response.skip
      : request.state === "skipped"
        ? request.skip
        : null;

  return skip
    ? t("markerNotCaptured", { reason: skipReasonText(skip, t, formatBytes, entry.mimeType) })
    : null;
}
