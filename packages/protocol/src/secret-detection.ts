/**
 * Content-based secret detection shared by every capture path that records page data a
 * redaction list cannot describe in advance (raw DOM, storage values). Everything here runs in
 * linear time: inputs are page-controlled.
 */

/** Replacement for a credential found inside free text. */
export const REDACTED_SECRET = "[REDACTED]";

/**
 * Name parts that mark a secret field, key or attribute (`sessionId`, `data-csrf-token`,
 * `x_api_key`). Matched without separators, so `apiKey` and `api-key` both read `apikey`.
 */
export const SECRET_NAME_PARTS: readonly string[] = [
  "token",
  "secret",
  "passw",
  "passcode",
  "session",
  "csrf",
  "xsrf",
  "nonce",
  "signature",
  "credential",
  "auth",
  "jwt",
  "apikey",
  "accesskey",
  "privatekey",
  "bearer",
  "cookie",
  "dsn",
  "sid",
  "pwd",
  "otp",
  "totp",
  "mfa",
  "pin",
  "ssn",
  "cvv",
  "cvc",
  "sig"
];

/** Short parts that hide inside unrelated words (`sidebar`, `spinner`, `hotpath`): whole words only. */
const WORD_ONLY_NAME_PARTS = new Set([
  "sid",
  "pwd",
  "otp",
  "totp",
  "mfa",
  "pin",
  "ssn",
  "cvv",
  "cvc",
  "sig",
  "dsn"
]);

/** `author…` is not `auth`, but `authorization` is. */
const AUTHOR_WORD_PATTERN = /^author(?!i[sz]ation)/;
const AUTHOR_TEXT_PATTERN = /author(?!i[sz]ation)/g;

/** Credential formats recognised whatever the field name. */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // JWT / JWS (an unsigned token has an empty third part). Patterns whose characters include `-`
  // start after a lookbehind, not `\b`: `a-eyJ…-eyJ…` must not restart the scan at every dash.
  /(?<![\w-])eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]*/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  // Base64 credentials: a digit, `+`, `/`, `=` or a lower-to-upper change ("Basic settings" is text).
  /\b(?:[Bb]asic|BASIC)\s+(?=[A-Za-z0-9+/]{0,64}(?:[0-9+/=]|[a-z][A-Z]))[A-Za-z0-9+/]{8,}={0,2}(?![A-Za-z0-9+/=])/g,
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/g,
  // Vendor keys: Stripe, GitHub, AWS, Slack, Google, GitLab, OpenAI/Anthropic, npm, SendGrid.
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /(?<![\w-])xox[abposr]-[\w-]{10,}/g,
  /(?<![\w-])AIza[\w-]{35}/g,
  /(?<![\w-])glpat-[\w-]{20,}/g,
  /(?<![\w-])sk-(?:ant-|proj-)?[\w-]{20,}/g,
  /\bnpm_[A-Za-z0-9]{36}/g,
  /(?<![\w-])SG\.[\w-]{16,}\.[\w-]{16,}/g
];

/** Candidate runs for {@link isTokenShaped}: long letter/digit runs without separators. */
const ALPHANUMERIC_RUN_PATTERN = /[A-Za-z0-9]{20,}/g;
const MIN_TOKEN_CHARS = 20;
/** A run this long that mixes letters and digits is a token (hex digests, base64, API keys). */
const LONG_TOKEN_CHARS = 32;
/** Shorter runs need several letter/digit changes (`a8F3k2…`), unlike `orderSummaryRow12`. */
const MIN_TOKEN_TRANSITIONS = 4;

/**
 * Lowercases and folds compatibility forms, so lookalike names match: fullwidth `ＴＯＫＥＮ`,
 * long s `ſession`, dotted `SESSİON`, dotless `sessıon`.
 */
export function foldSecretText(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/ı/g, "i");
}

/**
 * Whether a name, or any text, mentions a secret name part (or one of `extraParts`): anywhere
 * once separators are removed (`JSESSIONID`, `oauthState`, `data-csrftoken`), except inside
 * `author`; short parts must be a whole word (`sid`, not `sidebar`).
 */
export function mentionsSecretName(text: string, extraParts: readonly string[] = []): boolean {
  const words = foldSecretText(
    // One character plus a lookahead per split: `([A-Z]+)` would rescan long capital runs.
    text.replace(/([a-z0-9])(?=[A-Z])/g, "$1 ").replace(/([A-Z])(?=[A-Z][a-z])/g, "$1 ")
  )
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
  const collapsed = words.join("").replace(AUTHOR_TEXT_PATTERN, "");

  return [...SECRET_NAME_PARTS, ...extraParts].some((part) => {
    const normalized = foldSecretText(part).replace(/[^a-z0-9]+/g, "");

    if (normalized.length === 0) {
      return false;
    }

    if (WORD_ONLY_NAME_PARTS.has(normalized)) {
      return words.includes(normalized);
    }

    // `authOrigin` is `auth` + `origin` even though its letters spell `author…`.
    return (
      collapsed.includes(normalized) ||
      words.some((word) => word.startsWith(normalized) && !AUTHOR_WORD_PATTERN.test(word))
    );
  });
}

/**
 * Text with JSON (`\u0074oken`, any number of escaping backslashes) and URL (`%22token%22`)
 * escapes decoded, so a scan for secret names sees what a parser would.
 */
export function unescapeForScan(text: string): string {
  return text
    .replace(/(?<!\\)\\+u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    )
    .replace(/%([0-9a-fA-F]{2})/g, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    );
}

/** A letter/digit run that reads as a generated secret rather than a word or an id. */
export function isTokenShaped(run: string): boolean {
  if (run.length < MIN_TOKEN_CHARS || !/[0-9]/.test(run) || !/[A-Za-z]/.test(run)) {
    return false;
  }

  if (run.length >= LONG_TOKEN_CHARS) {
    return true;
  }

  let transitions = 0;

  for (let index = 1; index < run.length; index += 1) {
    if (isDigit(run[index - 1] ?? "") !== isDigit(run[index] ?? "")) {
      transitions += 1;
    }
  }

  return transitions >= MIN_TOKEN_TRANSITIONS;
}

/** Whether text holds a known credential format or a token-shaped run. */
export function containsCredential(text: string): boolean {
  if (CREDENTIAL_PATTERNS.some((pattern) => matches(pattern, text))) {
    return true;
  }

  return Array.from(text.matchAll(ALPHANUMERIC_RUN_PATTERN), (match) => match[0]).some(
    isTokenShaped
  );
}

/** Replaces every credential and token-shaped run in free text, keeping the rest. */
export function redactCredentials(text: string, replacement = REDACTED_SECRET): string {
  const withoutFormats = CREDENTIAL_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, replacement),
    text
  );

  return withoutFormats.replace(ALPHANUMERIC_RUN_PATTERN, (run) =>
    isTokenShaped(run) ? replacement : run
  );
}

function matches(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  const found = pattern.test(text);
  pattern.lastIndex = 0;
  return found;
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}
