import { redactPreviewText } from "../../../lib/response-preview.js";

/** Languages the code view highlights (Shiki grammars bundled with the network chunk). */
export type CodeLanguage = "json" | "javascript" | "html" | "css" | "xml" | "plain";

/** A body as the details pane shows it. */
export type BodyContent =
  | { kind: "empty" }
  | { kind: "json"; text: string; value: unknown }
  | { kind: "text"; text: string; language: CodeLanguage }
  | { kind: "image"; mime: string; bytes: Uint8Array }
  | { kind: "binary"; mime: string; bytes: Uint8Array };

const TEXTUAL_MIME = /^text\/|json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|svg/;

/** Bytes of an image the stage can show (`img-src blob:` in the CSP); SVG stays text. */
const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/;

/** Share of control bytes above which an untyped body counts as binary. */
const MAX_CONTROL_RATIO = 0.05;
const TEXT_SNIFF_BYTES = 1_024;

export function languageOfMime(mime: string): CodeLanguage {
  const value = mime.toLowerCase();

  if (value.includes("json")) {
    return "json";
  }

  if (value.includes("javascript") || value.includes("ecmascript")) {
    return "javascript";
  }

  if (value.includes("html")) {
    return "html";
  }

  if (value.includes("css")) {
    return "css";
  }

  return value.includes("xml") || value.includes("svg") ? "xml" : "plain";
}

/** Decodes body bytes by MIME type; text that parses as JSON becomes a JSON body. */
export function decodeBody(bytes: Uint8Array, mime: string): BodyContent {
  if (bytes.byteLength === 0) {
    return { kind: "empty" };
  }

  const normalized = mime.toLowerCase().split(";")[0]?.trim() ?? "";

  if (IMAGE_MIME.test(normalized)) {
    return { kind: "image", mime: normalized, bytes };
  }

  if (!TEXTUAL_MIME.test(normalized) && !looksLikeText(bytes)) {
    return { kind: "binary", mime: normalized || "application/octet-stream", bytes };
  }

  return decodeText(new TextDecoder().decode(bytes), languageOfMime(normalized));
}

/** Text (a request body, a socket frame) as JSON when it parses, else highlighted text. */
export function decodeText(text: string, language: CodeLanguage = "plain"): BodyContent {
  if (text.length === 0) {
    return { kind: "empty" };
  }

  const start = text.trimStart()[0];

  if (start === "{" || start === "[") {
    try {
      return { kind: "json", text, value: JSON.parse(text) as unknown };
    } catch {
      // Not JSON after all (or cut): shown as text below.
    }
  }

  return { kind: "text", text, language: language === "json" ? "plain" : language };
}

/** "Mask secrets": token, password, email and bearer values hidden (classic preview rule). */
export function maskBody(content: BodyContent): BodyContent {
  if (content.kind === "json") {
    // Masked in the parsed value, so numbers, objects and values with spaces stay valid JSON.
    const value = maskJsonValue(content.value);
    const text = content.text.includes("\n")
      ? JSON.stringify(value, null, 2)
      : JSON.stringify(value);
    return { kind: "json", text, value };
  }

  return content.kind === "text" ? { ...content, text: redactPreviewText(content.text) } : content;
}

/** JSON keys whose whole value is a secret, whatever its type. */
const SECRET_JSON_KEY =
  /password|passwd|token|secret|api[-_]?key|private[-_]?key|access[-_]?key|authorization|cookie|jwt|csrf|session|otp/i;
const MASKED_VALUE = "***";

function maskJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(maskJsonValue);
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_JSON_KEY.test(key) ? MASKED_VALUE : maskJsonValue(item)
      ])
    );
  }

  // Bearer tokens, e-mails and `token=…` inside string values.
  return typeof value === "string" ? redactPreviewText(value) : value;
}

/** Text for "Copy": JSON pretty-printed, text as is; images and binary have none. */
export function bodyCopyText(content: BodyContent): string | null {
  if (content.kind === "json") {
    return JSON.stringify(content.value, null, 2);
  }

  return content.kind === "text" ? content.text : null;
}

/** No MIME type to go by: printable UTF-8 in the first KiB counts as text. */
function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, TEXT_SNIFF_BYTES);
  let control = 0;

  for (const byte of sample) {
    if (byte === 0) {
      return false;
    }

    if (byte < 9 || (byte > 13 && byte < 32)) {
      control += 1;
    }
  }

  return control / Math.max(1, sample.byteLength) < MAX_CONTROL_RATIO;
}

/** `a=1&b=two` → pairs (form bodies); undecodable parts stay raw. */
export function parseFormPairs(text: string): Array<[string, string]> {
  return text
    .split("&")
    .filter((part) => part.length > 0)
    .map((part) => {
      const separator = part.indexOf("=");
      const name = separator < 0 ? part : part.slice(0, separator);
      const value = separator < 0 ? "" : part.slice(separator + 1);
      return [decodeFormPart(name), decodeFormPart(value)];
    });
}

function decodeFormPart(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return value;
  }
}

/** Query parameters of a URL, in order (empty for unparseable URLs). */
export function queryPairs(url: string): Array<[string, string]> {
  try {
    return [...new URL(url).searchParams];
  } catch {
    return [];
  }
}
