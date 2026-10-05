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
