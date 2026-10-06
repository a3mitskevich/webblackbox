import {
  isRealtimePayloadCut,
  isServiceRealtimeRecord,
  parseRealtimePayload,
  type ParsedRealtimePayload,
  type RealtimeNetworkEntry,
  type RealtimeRecord,
  type RealtimeStream
} from "@webblackbox/player-sdk";

import type { Selection } from "../../../core/navigation.js";
import { socketRowId, streamOfSelection, type NetworkModel } from "./rows.js";

/** What a conversation row shows: the hub method (or kind) and a one-line preview. */
export type MessageLabel = {
  entry: RealtimeNetworkEntry;
  parsed: ParsedRealtimePayload;
  title: string | null;
  preview: string;
  service: boolean;
};

function previewOf(record: RealtimeRecord | undefined): string {
  if (!record) {
    return "";
  }

  const value = record.value as { arguments?: unknown } | undefined;

  if (record.target && value && value.arguments !== undefined) {
    return JSON.stringify(value.arguments);
  }

  return record.text.replace(/\s+/g, " ");
}

export function labelMessage(entry: RealtimeNetworkEntry, signalr: boolean): MessageLabel {
  const parsed = parseRealtimePayload(entry.payloadPreview, {
    truncated: isRealtimePayloadCut(entry),
    opcode: entry.opcode,
    signalr
  });
  const first = parsed.records[0];

  return {
    entry,
    parsed,
    title: first?.target ?? null,
    preview: previewOf(first),
    service: parsed.records.length > 0 && parsed.records.every(isServiceRealtimeRecord)
  };
}

/** Labels of a stream's messages, optionally without the service ones. */
export function labelStreamMessages(stream: RealtimeStream, hideService: boolean): MessageLabel[] {
  const signalr = stream.format === "signalr";
  const labels = stream.messages.map((entry) => labelMessage(entry, signalr));
  return hideService ? labels.filter((label) => !label.service) : labels;
}

/**
 * The connection the Realtime tab shows: the one of the selected event, else the one picked in
 * the tab, else the busiest (sockets opened before the recording come first, often quiet).
 */
export function shownStream(
  model: NetworkModel,
  selection: Selection | null,
  chosenKey: string | null
): RealtimeStream | null {
  return (
    streamOfSelection(model, selection) ??
    model.streams.find((stream) => socketRowId(stream) === chosenKey) ??
    model.streams.reduce<RealtimeStream | null>(
      (busiest, stream) =>
        !busiest || stream.messages.length > busiest.messages.length ? stream : busiest,
      null
    )
  );
}
