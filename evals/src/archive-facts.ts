// What an archive actually holds, per kind of evidence: lets the report tell "the agent missed
// it" apart from "the recording never had it". Checks are generic (event types and fields of the
// Lite and Full shapes), not tuned to a scenario.

import { readFile } from "node:fs/promises";

import { WebBlackboxPlayer } from "@webblackbox/player-sdk";

import type { EvidenceKind } from "./types.js";

export type ArchiveFacts = Readonly<Record<EvidenceKind, boolean>>;

type ArchiveEvent = { type: string; data?: unknown };
type Data = Record<string, unknown>;

export async function inspectArchive(path: string, passphrase: string): Promise<ArchiveFacts> {
  const bytes = new Uint8Array(await readFile(path));
  const player = await WebBlackboxPlayer.open(bytes, { passphrase });
  return factsFromEvents(player.query() as readonly ArchiveEvent[]);
}

export function factsFromEvents(events: readonly ArchiveEvent[]): ArchiveFacts {
  const of = (...types: string[]) =>
    events.filter((event) => types.includes(event.type)).map((event) => asData(event.data));
  const requests = of("network.request");
  const responses = of("network.response");

  return {
    "click-target": of("user.click").some((data) => hasReadableTarget(asData(data.target))),
    dom: of("dom.snapshot").length > 0 || of("dom.rrweb.event").some(isFullSnapshot),
    exception: of("error.exception", "error.unhandledrejection").some(hasReadableMessage),
    iframe: events.some(isFromChildFrame) || documentFrameCount(requests) > 1,
    navigation: events.some((event) => event.type.startsWith("nav.")),
    "network-cache": responses.some(isFromCache) || of("network.finished").some(isFromCache),
    "network-pending": hasPendingRequest(requests, events),
    "network-request-body": requests.some(hasRequestBody),
    "network-response-body": of("network.body").some((data) =>
      /json|text\/plain|xml/.test(String(data.mimeType ?? ""))
    ),
    "network-status": responses.some((data) => typeof statusOf(data) === "number"),
    "network-timing": responses.some(
      (data) => typeof data.duration === "number" || typeof data.timestamp === "number"
    ),
    "storage-value": [...of("storage.local.snapshot"), ...of("storage.local.op")].some(
      hasStorageValue
    ),
    "user-input": of("user.input").some(
      (data) => data.valueRedacted !== true && typeof data.value === "string"
    ),
    websocket: events.some((event) => event.type.startsWith("network.ws."))
  };
}

/** Lite hashes targets into `selector:<hash>`; a readable target has a real selector or text. */
function hasReadableTarget(target: Data): boolean {
  const selector = typeof target.selector === "string" ? target.selector : "";
  return (
    (isRecord(target.readable) && Object.keys(target.readable).length > 0) ||
    (selector !== "" && !selector.startsWith("selector:"))
  );
}

function hasReadableMessage(data: Data): boolean {
  return (
    data.messageRedacted !== true &&
    [data.message, data.text, data.description].some(
      (value) => typeof value === "string" && value.trim() !== ""
    )
  );
}

function isFullSnapshot(data: Data): boolean {
  const event = asData(data.event);
  return event.type === 2 || event.type === "full-snapshot";
}

function isFromChildFrame(event: ArchiveEvent): boolean {
  const data = asData(event.data);
  return (
    (event.type.startsWith("user.") || event.type.startsWith("error.")) &&
    (data.isTopFrame === false || data.frameDepth !== undefined || isRecord(data.frame))
  );
}

/** CDP document loads keep the tab's main frame id across navigations; an iframe adds another. */
function documentFrameCount(requests: readonly Data[]): number {
  return new Set(
    requests
      .filter((data) => data.type === "Document" && typeof data.frameId === "string")
      .map((data) => data.frameId)
  ).size;
}

function isFromCache(data: Data): boolean {
  const response = asData(data.response);
  return [data, response].some(
    (value) =>
      value.fromDiskCache === true ||
      value.fromMemoryCache === true ||
      value.fromServiceWorker === true ||
      value.fromCache === true
  );
}

function hasPendingRequest(requests: readonly Data[], events: readonly ArchiveEvent[]): boolean {
  const settled = new Set(
    events
      .filter((event) =>
        ["network.response", "network.finished", "network.failed"].includes(event.type)
      )
      .map((event) => requestIdOf(asData(event.data)))
  );

  return requests.some((data) => {
    const id = requestIdOf(data);
    return id !== undefined && !settled.has(id);
  });
}

function hasRequestBody(data: Data): boolean {
  const request = asData(data.request);
  return (
    typeof request.postData === "string" ||
    (Array.isArray(request.postDataEntries) && request.postDataEntries.length > 0) ||
    typeof data.body === "string" ||
    typeof data.requestBody === "string"
  );
}

function hasStorageValue(data: Data): boolean {
  const entries = Array.isArray(data.entries) ? data.entries : [];
  return (
    entries.some((entry) => isRecord(entry) && typeof entry.value === "string") ||
    (typeof data.value === "string" && data.valueRedacted !== true)
  );
}

function statusOf(data: Data): unknown {
  return data.status ?? asData(data.response).status;
}

function requestIdOf(data: Data): string | undefined {
  const id = data.requestId ?? data.reqId;
  return typeof id === "string" ? id : undefined;
}

function asData(value: unknown): Data {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Data {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
