import { sanitizeUrlForPrivacy, type RedactionProfile } from "@webblackbox/protocol";

export type RedactionOptions = {
  /**
   * Secret key for HMAC-SHA-256 hashing of sensitive values. Keep it per session and in memory
   * only; it must never be exported with the archive. Defaults to a random key per JS realm.
   */
  hashKey?: Uint8Array;
};

type RedactionContext = {
  profile: RedactionProfile;
  hashKey: Uint8Array;
};

const REDACTED = "[REDACTED]";
const REDACTION_HASH_KEY_BYTES = 32;
const HMAC_BLOCK_BYTES = 64;
const HMAC_INNER_PAD = 0x36;
const HMAC_OUTER_PAD = 0x5c;
// Header values that carry URLs: their query/fragment can hold OAuth codes or tokens.
const URL_VALUED_HEADERS = new Set([
  "location",
  "content-location",
  "referer",
  "referrer",
  ":path",
  "src"
]);
// Unlisted headers whose name suggests a credential (e.g. X-Access-Token, X-Session-Id).
const SENSITIVE_HEADER_NAME_PATTERN =
  /token|secret|session|auth|key|passw(?:or)?d|credential|signature/;
// Unmask lists must never expose password fields, whatever the profile says.
const PASSWORD_SELECTOR_PATTERN = /passw(?:or)?d/i;
// Auth challenges carry no secret and explain 401/407 responses, so keep them readable.
// `:authority` is the HTTP/2 host pseudo-header; it only matches the name pattern via "auth".
const READABLE_AUTH_HEADERS = new Set(["www-authenticate", "proxy-authenticate", ":authority"]);
// Redaction runs on the synchronous ingest hot path (service worker + content/injected contexts).
// We intentionally keep hashing sync to avoid async pipeline stalls from crypto.subtle.
const SHA_256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

let defaultHashKey: Uint8Array | null = null;

/** Creates a random per-session key for {@link redactPayload}'s keyed hashing. */
export function createRedactionHashKey(): Uint8Array {
  const cryptoApi = globalThis.crypto;

  if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") {
    throw new Error("WebBlackbox redaction requires crypto.getRandomValues for keyed hashing.");
  }

  return cryptoApi.getRandomValues(new Uint8Array(REDACTION_HASH_KEY_BYTES));
}

export function redactPayload(
  input: unknown,
  profile: RedactionProfile,
  options: RedactionOptions = {}
): unknown {
  return redactValue(input, {
    profile,
    hashKey: options.hashKey ?? getDefaultHashKey()
  });
}

function getDefaultHashKey(): Uint8Array {
  defaultHashKey ??= createRedactionHashKey();
  return defaultHashKey;
}

function hashValue(value: string, context: RedactionContext): string {
  return hmacSha256Hex(context.hashKey, value);
}

function redactValue(input: unknown, context: RedactionContext): unknown {
  const { profile } = context;

  if (Array.isArray(input)) {
    return input.map((item) => redactValue(item, context));
  }

  if (input !== null && typeof input === "object") {
    const source = input as Record<string, unknown>;
    const output: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(source)) {
      const normalizedKey = key.toLowerCase();

      if (isUrlLikeField(normalizedKey) && typeof value === "string") {
        output[key] = sanitizeUrlForPrivacy(value);
        continue;
      }

      if (normalizedKey === "selector" && typeof value === "string") {
        output[key] = profile.hashSensitiveValues
          ? `selector:${hashValue(value, context).slice(0, 12)}`
          : "[REDACTED_SELECTOR]";
        continue;
      }

      if (profile.redactHeaders.includes(normalizedKey) || isSensitiveKey(normalizedKey, profile)) {
        output[key] = maskUnknown(value, context);
        continue;
      }

      if (normalizedKey === "headers" && value !== null && typeof value === "object") {
        output[key] = redactHeaders(value as Record<string, unknown>, context);
        continue;
      }

      if (isCookieField(normalizedKey)) {
        output[key] = redactCookieField(value, context, normalizedKey);
        continue;
      }

      if (
        (normalizedKey === "value" || normalizedKey === "text") &&
        (shouldMaskBySelector(source, profile) ||
          shouldMaskByCookieName(source, profile) ||
          hasSensitiveStorageKey(source, profile))
      ) {
        output[key] = typeof value === "string" ? maskString(value, context) : REDACTED;
        continue;
      }

      output[key] = redactValue(value, context);
    }

    return output;
  }

  if (typeof input === "string" && containsSensitivePattern(input, profile)) {
    return maskString(input, context);
  }

  return input;
}

function redactHeaders(
  headers: Record<string, unknown>,
  context: RedactionContext
): Record<string, unknown> {
  const next: Record<string, unknown> = {};

  for (const [header, value] of Object.entries(headers)) {
    const normalized = header.toLowerCase();

    if (context.profile.redactHeaders.includes(normalized)) {
      next[header] = maskUnknown(value, context);
      continue;
    }

    if (typeof value === "string" && (normalized === "cookie" || normalized === "set-cookie")) {
      next[header] = redactCookieHeaderValue(value, context, normalized);
      continue;
    }

    if (typeof value === "string" && isUrlValuedHeader(normalized)) {
      next[header] = sanitizeUrlForPrivacy(value);
      continue;
    }

    if (isSensitiveHeaderName(normalized, context.profile)) {
      next[header] = maskUnknown(value, context);
      continue;
    }

    next[header] = redactValue(value, context);
  }

  return next;
}

function isUrlValuedHeader(header: string): boolean {
  return URL_VALUED_HEADERS.has(header) || isUrlLikeField(header);
}

function isSensitiveHeaderName(header: string, profile: RedactionProfile): boolean {
  if (READABLE_AUTH_HEADERS.has(header)) {
    return false;
  }

  return SENSITIVE_HEADER_NAME_PATTERN.test(header) || isSensitiveKey(header, profile);
}

function isCookieField(key: string): boolean {
  return key === "cookie" || key === "cookies" || key === "set-cookie" || key === "setcookie";
}

function redactCookieField(value: unknown, context: RedactionContext, fieldName: string): unknown {
  if (typeof value === "string") {
    return redactCookieHeaderValue(value, context, fieldName);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactCookieField(entry, context, fieldName));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const cookieName = readCookieName(source);
  const shouldMaskValue = cookieName ? shouldRedactCookieName(cookieName, context.profile) : false;

  for (const [key, entry] of Object.entries(source)) {
    const normalizedKey = key.toLowerCase();

    if (shouldMaskValue && (normalizedKey === "value" || normalizedKey === "text")) {
      output[key] = typeof entry === "string" ? maskString(entry, context) : REDACTED;
      continue;
    }

    output[key] = redactValue(entry, context);
  }

  return output;
}

function redactCookieHeaderValue(
  value: string,
  context: RedactionContext,
  headerName: string
): string {
  const { profile } = context;

  if (profile.redactCookieNames.length === 0) {
    return value;
  }

  if (headerName === "cookie") {
    const parts = value.split(";");

    return parts
      .map((entry) => {
        const trimmed = entry.trim();
        const equalsIndex = trimmed.indexOf("=");

        if (equalsIndex <= 0) {
          return trimmed;
        }

        const cookieName = trimmed.slice(0, equalsIndex).trim();

        if (!shouldRedactCookieName(cookieName, profile)) {
          return trimmed;
        }

        const rawValue = trimmed.slice(equalsIndex + 1);
        return `${cookieName}=${maskString(rawValue, context)}`;
      })
      .join("; ");
  }

  const lines = value
    .split(/\r?\n/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const source = lines.length > 0 ? lines : [value];

  return source
    .map((line) => {
      const semiIndex = line.indexOf(";");
      const firstPair = semiIndex >= 0 ? line.slice(0, semiIndex) : line;
      const equalsIndex = firstPair.indexOf("=");

      if (equalsIndex <= 0) {
        return line;
      }

      const cookieName = firstPair.slice(0, equalsIndex).trim();

      if (!shouldRedactCookieName(cookieName, profile)) {
        return line;
      }

      const cookieValue = firstPair.slice(equalsIndex + 1).trim();
      const masked = `${cookieName}=${maskString(cookieValue, context)}`;
      return semiIndex >= 0 ? `${masked}${line.slice(semiIndex)}` : masked;
    })
    .join("\n");
}

function readCookieName(source: Record<string, unknown>): string | null {
  const candidates = [source.name, source.cookieName, source.key];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

function shouldRedactCookieName(name: string, profile: RedactionProfile): boolean {
  const normalizedName = name.trim().toLowerCase();

  if (!normalizedName) {
    return false;
  }

  return profile.redactCookieNames.some((entry) => entry.trim().toLowerCase() === normalizedName);
}

function shouldMaskByCookieName(
  source: Record<string, unknown>,
  profile: RedactionProfile
): boolean {
  const cookieName = readCookieName(source);

  if (!cookieName) {
    return false;
  }

  const cookieSignals = ["domain", "path", "samesite", "httponly", "secure", "expires", "size"];
  const keys = Object.keys(source).map((key) => key.toLowerCase());
  const looksLikeCookieRecord =
    keys.some((key) => key.includes("cookie")) ||
    cookieSignals.some((signal) => keys.includes(signal));

  if (!looksLikeCookieRecord) {
    return false;
  }

  return shouldRedactCookieName(cookieName, profile);
}

/** Short secret names stores use besides the cookie list (`sid`, `pwd`, `accessJwt`…). */
const STORAGE_SECRET_NAMES = ["sid", "pwd", "jwt", "auth", "session", "credential", "passwd"];
/** Field names of JSON text, escaped or not (`{"sessionId":…}`, `{\"accessJwt\":…}`). */
const JSON_FIELD_NAME_PATTERN = /\\?"([A-Za-z0-9_$.-]{1,64})\\?"\s*:/g;
const MAX_JSON_FIELD_NAMES = 200;

/** Values that are credentials whatever their key: JWTs, bearer tokens, private keys. */
const CREDENTIAL_VALUE_PATTERNS = [
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=_-]{16,}/i,
  // Base64 credentials: a digit, `+`, `/`, `=` or a lower-to-upper change ("basic plan" is text).
  /\b[Bb]asic\s+(?=[A-Za-z0-9+/]{0,64}(?:[0-9+/=]|[a-z][A-Z]))[A-Za-z0-9+/]{12,}={0,2}(?![A-Za-z0-9+/=])/,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/
];

/** Names matched only as a whole word (`sid` is inside `sidebar`, `inside`…). */
const WORD_ONLY_SECRET_NAMES = new Set(["sid"]);

/**
 * Whether a key or field name mentions a secret name: anywhere in the name without separators
 * (`JSESSIONID`, `oauthState`, `mycsrf`), except inside `author`; word-only names must be a
 * whole word (`sid`, not `sidebar`).
 */
function nameMentions(field: string, secretName: string): boolean {
  const normalized = secretName.toLowerCase().replace(/[^a-z0-9]+/g, "");

  if (normalized.length === 0) {
    return false;
  }

  const words = field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);

  if (WORD_ONLY_SECRET_NAMES.has(normalized)) {
    return words.includes(normalized);
  }

  // `authOrigin` is `auth` + `origin` even though its letters spell `author…`.
  return (
    words.some((word) => word.startsWith(normalized) && !word.startsWith("author")) ||
    field
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .replaceAll("author", "")
      .includes(normalized)
  );
}

/** Field names in a JSON-looking value (capped), so nested secrets are found. */
function jsonFieldNames(value: string): string[] {
  if (!/[{[]/.test(value)) {
    return [];
  }

  return Array.from(value.matchAll(JSON_FIELD_NAME_PATTERN), (match) => match[1] ?? "").slice(
    0,
    MAX_JSON_FIELD_NAMES
  );
}

/**
 * `{ key, value }` records (storage ops and snapshot entries): the value is masked when the key
 * name is sensitive (body patterns or a cookie-style name such as `session` or `jwt`) or when
 * the value itself looks like a credential.
 */
function hasSensitiveStorageKey(
  source: Record<string, unknown>,
  profile: RedactionProfile
): boolean {
  if (typeof source.key !== "string") {
    return false;
  }

  const key = source.key.toLowerCase();
  const value =
    typeof source.value === "string"
      ? source.value
      : typeof source.text === "string"
        ? source.text
        : "";
  const names = [...profile.redactCookieNames, ...STORAGE_SECRET_NAMES];

  return (
    isSensitiveKey(key, profile) ||
    names.some((name) => nameMentions(source.key as string, name)) ||
    CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value)) ||
    jsonFieldNames(value).some(
      (field) =>
        isSensitiveKey(field.toLowerCase(), profile) ||
        names.some((name) => nameMentions(field, name))
    )
  );
}

function isSensitiveKey(key: string, profile: RedactionProfile): boolean {
  return profile.redactBodyPatterns.some((pattern) => key.includes(pattern.toLowerCase()));
}

function isUrlLikeField(key: string): boolean {
  return (
    key === "url" ||
    key === "href" ||
    key === "responseurl" ||
    key === "documenturl" ||
    key === "requesturl" ||
    key === "referrer" ||
    key === "referer" ||
    key === "src" ||
    key.endsWith("url")
  );
}

function containsSensitivePattern(value: string, profile: RedactionProfile): boolean {
  const lowered = value.toLowerCase();
  return profile.redactBodyPatterns.some((pattern) => lowered.includes(pattern.toLowerCase()));
}

function shouldMaskBySelector(source: Record<string, unknown>, profile: RedactionProfile): boolean {
  const selector = source.selector;

  if (typeof selector !== "string") {
    return false;
  }

  if (!profile.blockedSelectors.some((blocked) => selector.includes(blocked))) {
    return false;
  }

  return !isUnmaskedSelector(selector, profile);
}

/** True when `selector` matches a profile unmask entry; password fields are never unmasked. */
export function isUnmaskedSelector(selector: string, profile: RedactionProfile): boolean {
  const unmaskSelectors = profile.unmaskSelectors ?? [];

  if (unmaskSelectors.length === 0 || PASSWORD_SELECTOR_PATTERN.test(selector)) {
    return false;
  }

  return unmaskSelectors.some((entry) => entry.length > 0 && selector.includes(entry));
}

function maskString(value: string, context: RedactionContext): string {
  if (context.profile.hashSensitiveValues) {
    return hashValue(value, context);
  }

  return REDACTED;
}

function maskUnknown(value: unknown, context: RedactionContext): string {
  return typeof value === "string" ? maskString(value, context) : REDACTED;
}

function hmacSha256Hex(key: Uint8Array, value: string): string {
  const blockKey = key.byteLength > HMAC_BLOCK_BYTES ? sha256(key) : key;
  const message = new TextEncoder().encode(value);
  const inner = new Uint8Array(HMAC_BLOCK_BYTES + message.byteLength);
  const outer = new Uint8Array(HMAC_BLOCK_BYTES + 32);

  for (let index = 0; index < HMAC_BLOCK_BYTES; index += 1) {
    const keyByte = blockKey[index] ?? 0;
    inner[index] = keyByte ^ HMAC_INNER_PAD;
    outer[index] = keyByte ^ HMAC_OUTER_PAD;
  }

  inner.set(message, HMAC_BLOCK_BYTES);
  outer.set(sha256(inner), HMAC_BLOCK_BYTES);

  return Array.from(sha256(outer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sha256(message: Uint8Array): Uint8Array {
  const bitLength = message.length * 8;
  const totalLength = ((message.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(totalLength);
  padded.set(message);
  padded[message.length] = 0x80;

  const view = new DataView(padded.buffer);
  const highBits = Math.floor(bitLength / 0x100000000);
  const lowBits = bitLength >>> 0;
  view.setUint32(padded.length - 8, highBits);
  view.setUint32(padded.length - 4, lowBits);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const words = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }

    for (let index = 16; index < 64; index += 1) {
      const s0 =
        rightRotate(words[index - 15]!, 7) ^
        rightRotate(words[index - 15]!, 18) ^
        (words[index - 15]! >>> 3);
      const s1 =
        rightRotate(words[index - 2]!, 17) ^
        rightRotate(words[index - 2]!, 19) ^
        (words[index - 2]! >>> 10);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choose + SHA_256_K[index]! + words[index]!) >>> 0;
      const sum0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((part, index) => {
    digestView.setUint32(index * 4, part);
  });

  return digest;
}

function rightRotate(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}
