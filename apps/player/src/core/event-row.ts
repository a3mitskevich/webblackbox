import type { WebBlackboxEvent } from "@webblackbox/protocol";

import { asFiniteNumber, asRecord, asString } from "../lib/parsing.js";
import { extractReqIdFromEvent } from "../lib/scope.js";
import { compactText, shortUrl } from "../lib/text.js";
import { isErrorEvent, type ArchiveModel } from "./archive-model.js";

/** Glyph and colour family of a list row (PROPOSAL §8 semantics). */
export type EventRowKind =
  | "action"
  | "navigation"
  | "request"
  | "error"
  | "realtime"
  | "console"
  | "storage"
  | "media"
  | "meta";

export type EventRow = {
  kind: EventRowKind;
  /** Main line: URL, status, selector or message — archive text, not translated. */
  primary: string;
  /** Second line (target selector, MIME type, …), when there is one. */
  secondary: string;
  /** HTTP status for request rows (shown as a coloured code). */
  status: number | null;
  isError: boolean;
};

/** Low-level companions of an activity: shown in their request/socket/action, not as rows. */
const NOISE_TYPES = new Set([
  "network.response",
  "network.finished",
  "network.body",
  "network.redirect",
  "network.ws.frame",
  "user.mousemove",
  "user.pointerdown",
  "user.pointerup",
  "user.hover",
  "user.scroll",
  "user.wheel",
  "user.click.reaction",
  "user.focus",
  "user.blur",
  "screen.recording.chunk",
  "perf.trace"
]);

const PRIMARY_MAX = 140;
const SECONDARY_MAX = 120;

/** Rows of the activity list: every event except the low-level companions above. */
export function isActivityEvent(event: WebBlackboxEvent): boolean {
  return !NOISE_TYPES.has(event.type) || isErrorEvent(event);
}

function readTarget(data: Record<string, unknown> | null): { text: string; css: string } {
  const target = asRecord(data?.target);
  const readable = asRecord(target?.readable);

  return {
    text: asString(readable?.text) ?? asString(target?.text) ?? "",
    css: asString(readable?.css) ?? asString(target?.selector) ?? asString(target?.tag) ?? ""
  };
}

function kindOf(event: WebBlackboxEvent, isError: boolean): EventRowKind {
  if (isError) {
    return "error";
  }

  const [family] = event.type.split(".");

  switch (family) {
    case "user":
      return "action";
    case "nav":
      return "navigation";
    case "network":
      return event.type.startsWith("network.ws") || event.type === "network.sse.message"
        ? "realtime"
        : "request";
    case "console":
      return "console";
    case "storage":
      return "storage";
    case "screen":
      return "media";
    default:
      return "meta";
  }
}

/**
 * One list row for an event. Request rows take method, status and URL from the waterfall entry
 * so the row shows the outcome at the request's start.
 */
export function describeEventRow(event: WebBlackboxEvent, model: ArchiveModel): EventRow {
  const data = asRecord(event.data);
  const reqId = extractReqIdFromEvent(event);
  const entry = reqId ? model.waterfallByReqId.get(reqId) : undefined;
  const failedStatus =
    entry && (entry.failed || (typeof entry.status === "number" && entry.status >= 400));
  const isError =
    isErrorEvent(event) || (event.type === "network.request" && Boolean(failedStatus));
  const kind = kindOf(event, isError);
  const row = (primary: string, secondary = "", status: number | null = null): EventRow => ({
    kind,
    primary: compactText(primary, PRIMARY_MAX),
    secondary: compactText(secondary, SECONDARY_MAX),
    status,
    isError
  });

  if (event.type === "network.request" || event.type === "network.failed") {
    const method = (
      entry?.method ??
      asString(asRecord(data?.request)?.method) ??
      "GET"
    ).toUpperCase();
    const url = entry?.url ?? asString(asRecord(data?.request)?.url) ?? asString(data?.url) ?? "";
    const outcome = entry?.failed ? (entry.errorText ?? "failed") : (entry?.mimeType ?? "");
    const duration = entry ? `${Math.round(entry.durationMs)} ms` : "";

    return row(
      `${method} ${shortUrl(url)}`,
      [duration, outcome, hostOf(url)].filter(Boolean).join(" · "),
      typeof entry?.status === "number" ? entry.status : null
    );
  }

  if (event.type.startsWith("network.ws") || event.type === "network.sse.message") {
    return row(shortUrl(asString(data?.url) ?? ""), hostOf(asString(data?.url) ?? ""));
  }

  if (event.type.startsWith("user.")) {
    const target = readTarget(data);
    const text = target.text ? `“${target.text}”` : target.css;
    return row(text || event.type, target.text ? target.css : "");
  }

  if (event.type.startsWith("nav.")) {
    const url = asString(data?.url) ?? asString(asRecord(data?.frame)?.url) ?? "";
    return row(shortUrl(url), asString(data?.navigationType) ?? asString(data?.type) ?? "");
  }

  if (event.type === "screen.screenshot") {
    const width = asFiniteNumber(data?.w);
    const height = asFiniteNumber(data?.h);
    return row(asString(data?.reason) ?? "", width && height ? `${width}×${height}` : "");
  }

  const message =
    asString(data?.message) ??
    asString(data?.text) ??
    asString(data?.key) ??
    asString(data?.reason) ??
    asString(data?.state) ??
    "";

  return row(message, asString(data?.stackTop) ?? asString(data?.url) ?? "");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
