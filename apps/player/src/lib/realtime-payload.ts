/** ASCII record separator: SignalR's JSON hub protocol ends every message with it. */
const RECORD_SEPARATOR = "\u001e";

/**
 * Formats a WebSocket frame or SSE message for reading: SignalR frames are split into their records
 * (each under a "Record i of n" header when there are several) and JSON is pretty-printed. Text that
 * is not valid JSON — including a frame cut at the body limit — is shown as it is.
 */
export function formatRealtimePayload(
  text: string,
  recordLabel: (index: number, count: number) => string
): string {
  const records = text.includes(RECORD_SEPARATOR)
    ? text.split(RECORD_SEPARATOR).filter((record) => record.length > 0)
    : [text];

  if (records.length <= 1) {
    return formatJson(records[0] ?? "");
  }

  return records
    .map(
      (record, index) => `── ${recordLabel(index + 1, records.length)} ──\n${formatJson(record)}`
    )
    .join("\n\n");
}

function formatJson(text: string): string {
  const trimmed = text.trim();

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return text;
  }

  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

export type RealtimePayloadLabels = {
  noPayload: string;
  truncated: string;
  loadFailed: (reason: string) => string;
  record: (index: number, count: number) => string;
};

/**
 * Text for an expanded realtime row: the formatted payload (with a note when the recorder cut it),
 * "no payload" when the event has none, or the reason the full payload could not be loaded.
 */
export async function readRealtimePayloadView(
  loadText: () => Promise<string | null>,
  isTruncated: boolean,
  labels: RealtimePayloadLabels
): Promise<string> {
  let text: string | null;

  try {
    text = await loadText();
  } catch (error) {
    return labels.loadFailed(error instanceof Error ? error.message : String(error));
  }

  if (text === null) {
    return labels.noPayload;
  }

  const formatted = formatRealtimePayload(text, labels.record);
  return isTruncated ? `${formatted}\n\n${labels.truncated}` : formatted;
}
