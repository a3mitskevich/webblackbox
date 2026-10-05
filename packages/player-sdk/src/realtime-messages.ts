/**
 * Reading WebSocket / SSE payloads: SignalR hub messages (JSON records ended by the `\u001e` record
 * separator), plain JSON and text. A payload the recorder cut at the profile limit still yields
 * what it can: the records before the cut, and for the cut record its SignalR type and target.
 */

/** ASCII record separator: SignalR's JSON hub protocol ends every message with it. */
export const SIGNALR_RECORD_SEPARATOR = "\u001e";

/** What the payload is as a whole. */
export type RealtimePayloadFormat = "signalr" | "json" | "text" | "binary" | "empty";

/**
 * One message of a payload. SignalR kinds follow the hub protocol message types; `handshake` is
 * the client's protocol request and `handshake-ack` the server's answer.
 */
export type RealtimeRecordKind =
  | "handshake"
  | "handshake-ack"
  | "invocation"
  | "stream-item"
  | "completion"
  | "stream-invocation"
  | "cancel-invocation"
  | "ping"
  | "close"
  | "ack"
  | "sequence"
  | "json"
  | "text"
  | "binary"
  | "empty";

export type RealtimeRecord = {
  kind: RealtimeRecordKind;
  /** The record text without the separator. */
  text: string;
  /** Parsed JSON, when the record is complete JSON. */
  value?: unknown;
  /** SignalR `target` (the hub method) of an invocation. */
  target?: string;
  invocationId?: string;
  /** SignalR message `type` (1 … 9). */
  signalrType?: number;
  /** SignalR completion or close error. */
  error?: string;
  /** False for the last record of a cut payload: its text stops where the recording stopped. */
  complete: boolean;
};

export type ParsedRealtimePayload = {
  format: RealtimePayloadFormat;
  records: RealtimeRecord[];
  /** The recorder kept only a prefix of the payload. */
  truncated: boolean;
};

export type ParseRealtimePayloadOptions = {
  /** The recorder hit the profile body limit (`payloadTruncated`). */
  truncated?: boolean;
  /** WebSocket opcode: 2 is a binary frame. */
  opcode?: number;
  /**
   * The stream is known to speak SignalR (another frame had the separator), so a cut record
   * without its separator is still read as a hub message.
   */
  signalr?: boolean;
};

const WS_BINARY_OPCODE = 2;

const SIGNALR_KINDS: Record<number, RealtimeRecordKind> = {
  1: "invocation",
  2: "stream-item",
  3: "completion",
  4: "stream-invocation",
  5: "cancel-invocation",
  6: "ping",
  7: "close",
  8: "ack",
  9: "sequence"
};

const SERVICE_KINDS: ReadonlySet<RealtimeRecordKind> = new Set([
  "handshake",
  "handshake-ack",
  "ping",
  "ack",
  "sequence",
  "empty"
]);

/** Splits and classifies a payload. `null` / empty text gives an `empty` payload. */
export function parseRealtimePayload(
  text: string | null | undefined,
  options: ParseRealtimePayloadOptions = {}
): ParsedRealtimePayload {
  const truncated = options.truncated === true;

  if (options.opcode === WS_BINARY_OPCODE) {
    return {
      format: "binary",
      truncated,
      records: [{ kind: "binary", text: text ?? "", complete: !truncated }]
    };
  }

  if (!text) {
    return { format: "empty", truncated, records: [{ kind: "empty", text: "", complete: true }] };
  }

  if (text.includes(SIGNALR_RECORD_SEPARATOR) || options.signalr) {
    return { format: "signalr", truncated, records: splitSignalrRecords(text, truncated) };
  }

  const record = readPlainRecord(text, !truncated);
  return { format: record.kind === "text" ? "text" : "json", truncated, records: [record] };
}

/**
 * Handshakes, pings, acks and completions without a result (`null` or none: a void hub method):
 * the plumbing of a hub connection, shown dimmed in a conversation.
 */
export function isServiceRealtimeRecord(record: RealtimeRecord): boolean {
  if (SERVICE_KINDS.has(record.kind)) {
    return true;
  }

  if (record.kind !== "completion" || record.error) {
    return false;
  }

  const value = asRecord(record.value);
  return value !== null && (value.result === undefined || value.result === null);
}

function splitSignalrRecords(text: string, truncated: boolean): RealtimeRecord[] {
  const parts = text.split(SIGNALR_RECORD_SEPARATOR);
  // The text after the last separator: empty for a whole frame, a cut record otherwise.
  const tail = parts.pop() ?? "";
  const records = parts
    .filter((part) => part.length > 0)
    .map((part) => readSignalrRecord(part, true));

  if (tail.length > 0) {
    records.push(readSignalrRecord(tail, !truncated && parseJson(tail) !== undefined));
  }

  return records.length > 0 ? records : [{ kind: "empty", text: "", complete: true }];
}

function readSignalrRecord(text: string, complete: boolean): RealtimeRecord {
  const value = complete ? parseJson(text) : undefined;
  const object = asRecord(value);

  if (!object) {
    return readCutSignalrRecord(text, complete);
  }

  const signalrType = typeof object.type === "number" ? object.type : undefined;
  const kind =
    signalrType === undefined ? readUntypedKind(object) : (SIGNALR_KINDS[signalrType] ?? "json");

  return {
    kind,
    text,
    value,
    complete: true,
    ...pickString("target", object.target),
    ...pickString("invocationId", object.invocationId),
    ...(signalrType === undefined ? {} : { signalrType }),
    ...pickString("error", object.error)
  };
}

/** A hub message without `type`: the handshake request (`protocol`) or its answer (`{}`). */
function readUntypedKind(object: Record<string, unknown>): RealtimeRecordKind {
  if (typeof object.protocol === "string") {
    return "handshake";
  }

  return Object.keys(object).length === 0 || typeof object.error === "string"
    ? "handshake-ack"
    : "json";
}

/** What a cut or malformed record still tells: its type and target, read from the prefix. */
function readCutSignalrRecord(text: string, complete: boolean): RealtimeRecord {
  const typeMatch = /"type"\s*:\s*(\d+)/.exec(text);
  const signalrType = typeMatch ? Number(typeMatch[1]) : undefined;
  const target = /"target"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
  const invocationId = /"invocationId"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
  const kind: RealtimeRecordKind =
    signalrType !== undefined
      ? (SIGNALR_KINDS[signalrType] ?? "json")
      : looksLikeJson(text)
        ? "json"
        : "text";

  return {
    kind,
    text,
    complete,
    ...(target === undefined ? {} : { target }),
    ...(invocationId === undefined ? {} : { invocationId }),
    ...(signalrType === undefined ? {} : { signalrType })
  };
}

function readPlainRecord(text: string, complete: boolean): RealtimeRecord {
  if (!looksLikeJson(text)) {
    return { kind: "text", text, complete };
  }

  const value = complete ? parseJson(text) : undefined;

  if (value === undefined) {
    // Cut JSON stays JSON (the viewer re-indents the prefix); malformed text is just text.
    return { kind: complete ? "text" : "json", text, complete };
  }

  return { kind: "json", text, value, complete };
}

function looksLikeJson(text: string): boolean {
  const start = text.trimStart()[0];
  return start === "{" || start === "[";
}

function parseJson(text: string): unknown {
  if (!looksLikeJson(text)) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickString<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
  return typeof value === "string" ? ({ [key]: value } as Record<K, string>) : {};
}
