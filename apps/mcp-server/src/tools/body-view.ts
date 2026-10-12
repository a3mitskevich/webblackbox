import { cutText } from "./budget.js";

/**
 * A request or response body as the agent reads it: decoded text (JSON pretty-printed), cut to a
 * byte budget with "N of M bytes", or a short hex preview for binary bodies; and why a body is
 * missing when the archive has none.
 */
export type BodyView = {
  present: boolean;
  mimeType: string | null;
  kind: "json" | "text" | "binary" | null;
  /** Bytes of the body as sent or received, when the capture knows it. */
  originalBytes: number | null;
  /** Bytes the archive holds (a prefix when the capture cut it). */
  storedBytes: number | null;
  /** The capture kept only a prefix of the body (profile body limit). */
  capturedPrefixOnly: boolean;
  /** UTF-8 bytes of the readable text (JSON pretty-printed), before `maxBodyBytes`. */
  textBytes: number | null;
  /** This call returned only part of the text (`maxBodyBytes`). */
  truncated: boolean;
  /** `"16384 of 90210 bytes"` of the text when `truncated`. */
  note: string | null;
  text: string | null;
  /** First bytes of a binary body, hex. */
  hexPreview: string | null;
  /** Why the archive holds no body. */
  missingReason: string | null;
};

const HEX_PREVIEW_BYTES = 32;
const JSON_MIME_PATTERN = /[/+]json\b/i;
const JSON_START_PATTERN = /^\s*[[{]/;

export function missingBody(mimeType: string | null, reason: string): BodyView {
  return {
    present: false,
    mimeType,
    kind: null,
    originalBytes: null,
    storedBytes: null,
    capturedPrefixOnly: false,
    textBytes: null,
    truncated: false,
    note: null,
    text: null,
    hexPreview: null,
    missingReason: reason
  };
}

export type BodySource = {
  mimeType: string | null;
  originalBytes: number | null;
  capturedPrefixOnly: boolean;
  maxBytes: number;
};

export function viewBodyBytes(bytes: Uint8Array, source: BodySource): BodyView {
  const text = decodeUtf8(bytes);

  if (text === null) {
    return {
      present: true,
      mimeType: source.mimeType,
      kind: "binary",
      originalBytes: source.originalBytes,
      storedBytes: bytes.byteLength,
      capturedPrefixOnly: source.capturedPrefixOnly,
      textBytes: null,
      truncated: false,
      note: null,
      text: null,
      hexPreview: Buffer.from(bytes.subarray(0, HEX_PREVIEW_BYTES)).toString("hex"),
      missingReason: null
    };
  }

  return viewBodyText(text, { ...source, storedBytes: bytes.byteLength });
}

export function viewBodyText(
  text: string,
  source: BodySource & { storedBytes?: number }
): BodyView {
  const pretty = prettyJson(text, source.mimeType);
  const cut = cutText(pretty ?? text, source.maxBytes);

  return {
    present: true,
    mimeType: source.mimeType,
    kind: pretty === null ? "text" : "json",
    originalBytes: source.originalBytes,
    storedBytes: source.storedBytes ?? Buffer.byteLength(text, "utf8"),
    capturedPrefixOnly: source.capturedPrefixOnly,
    textBytes: cut.totalBytes,
    truncated: cut.truncated,
    note: cut.note,
    text: cut.text,
    hexPreview: null,
    missingReason: null
  };
}

/** Pretty JSON, or null when the text is not JSON (a cut prefix never parses). */
function prettyJson(text: string, mimeType: string | null): string | null {
  if (!JSON_MIME_PATTERN.test(mimeType ?? "") && !JSON_START_PATTERN.test(text)) {
    return null;
  }

  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}
