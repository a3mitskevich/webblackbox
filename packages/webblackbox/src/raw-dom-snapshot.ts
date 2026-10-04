import { sanitizeUrlForPrivacy } from "@webblackbox/protocol";

import { isNeverCapturedField } from "./input-value-policy.js";

/** Longest raw DOM snapshot kept, in characters (the materializer also caps the bytes). */
export const RAW_DOM_SNAPSHOT_MAX_CHARS = 1_000_000;

const MASKED_TEXT = "[REDACTED]";
const MASKED_ATTRIBUTE = "data-webblackbox-masked";
/** Attributes a masked element keeps, so the page layout still reads. */
const MASKED_KEPT_ATTRIBUTES = new Set(["class", "style"]);
/** Never written: code (and secrets inlined in it), noscript markup, the extension's own UI. */
const DROPPED_SELECTOR = "script, noscript, [data-webblackbox-indicator]";
/** Attributes holding URLs; their query and fragment are stripped like every recorded URL. */
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "poster",
  "cite",
  "data",
  "background",
  "ping"
]);
/** Attributes never written: inline documents. Event handler attributes (`on*`) are dropped too. */
const DROPPED_ATTRIBUTES = new Set(["srcdoc"]);
/** `<meta>` whose `content` is kept; others (CSRF tokens, verification codes…) lose it. */
const KEPT_META_NAMES = new Set(["viewport", "theme-color", "color-scheme", "description"]);
/** Attribute name words that mark a secret value whatever the profile's redaction lists say. */
const SENSITIVE_ATTRIBUTE_NAME_PARTS = [
  "csrf",
  "xsrf",
  "token",
  "secret",
  "password",
  "nonce",
  "session",
  "signature",
  "otp",
  "otpcode",
  "onetime",
  "credential",
  "authorization",
  "apikey",
  "accesskey",
  "privatekey",
  "auth",
  "sid",
  "jwt",
  "pwd"
];
/** Name parts matched as whole words only (short, often inside unrelated words). */
const WORD_ONLY_NAME_PARTS = new Set(["otp", "auth", "sid", "jwt", "pwd"]);
/**
 * A URL query inside CSS (`?` up to a delimiter): one character class, so stripping stays
 * linear. Only used where the scanner cannot tell the URL bounds (comments, unterminated text).
 */
// `#…` only with `=` (a token fragment, not a colour or id); each class stops at the next `#`/`=`.
const CSS_QUERY_PATTERN = /\?[^\s"'()<>;,]*|#[^\s"'()<>;,#=]*=[^\s"'()<>;,]*/g;
/** Values that are credentials whatever the attribute: JWTs, bearer/basic tokens, keys. */
const CREDENTIAL_VALUE_PATTERNS = [
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=_-]{16,}/i,
  // Base64 credentials: a digit, `+`, `/`, `=` or a lower-to-upper change ("Basic settings" is text).
  /\b(?:[Bb]asic|BASIC)\s+(?=[A-Za-z0-9+/]{0,64}(?:[0-9+/=]|[a-z][A-Z]))[A-Za-z0-9+/]{8,}={0,2}(?![A-Za-z0-9+/=])/,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/
];
/** Serialized page state (`data-page='{"auth":{"sid":…}}'`) naming a secret field. */
const JSON_SECRET_KEY_PATTERN =
  /"[\w$.-]{0,40}?(?:token|secret|passw|pwd|session|sid|auth|jwt|credential|csrf)[\w$.-]{0,40}"\s*:/i;
/** An attribute value that is a URL on its own (`data-src`, `longdesc`, `codebase`…). */
const URL_SHAPED_VALUE_PATTERN = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|\/[^\s/]|\.\.?\/)\S*$/i;
/** A CSS string that is a URL (`@import "/x.css"`, `image-set("a.png" 1x)`). */
const CSS_URL_STRING_PATTERN =
  /^(?:[a-z][a-z0-9+.-]*:|\/|\.\.?\/)\S*$|^[^\s"']+\.[a-z0-9]{2,5}(?:[?#]\S*)?$|^[^\s"']*[?#][^\s"']*=/i;
/** Elements whose `value` attribute is form data (inputs are handled field by field). */
const VALUE_ATTRIBUTE_ELEMENTS = new Set(["BUTTON", "OPTION", "PARAM", "DATA", "METER"]);

export type RawDomSnapshot = {
  html: string;
  htmlLength: number;
  truncated: boolean;
};

export type RawDomSnapshotOptions = {
  /** Elements whose content (and descendants) is replaced by a mask. */
  blockedSelectors: readonly string[];
  /** Keep field values (`inputs: allow`); never for passwords, card or hidden fields. */
  keepInputValues: boolean;
  /** Extra attribute-name parts that mark secret values (the profile's body patterns). */
  sensitiveNamePatterns?: readonly string[];
};

type SanitizeContext = {
  options: RawDomSnapshotOptions;
  sensitiveNameParts: string[];
};

/**
 * The page as HTML for `dom: allow`. Works on a detached clone, so the page is never touched.
 * The HTML is stored as a blob the recorder's redactor never sees, so everything that could
 * carry a secret is handled here. Returns null when a blocked selector is invalid: without it
 * nothing proves the blocked content is masked, so the caller records a summary (fail closed).
 */
export function serializeRawDom(
  document: Document,
  options: RawDomSnapshotOptions
): RawDomSnapshot | null {
  const root = document.documentElement;

  if (!root) {
    return null;
  }

  // Decided on the live fields: a revealed password is only known as one on the page itself.
  const privateFields = Array.from(root.querySelectorAll("input"), (input) =>
    isNeverCapturedField(input)
  );
  const clone = root.cloneNode(true) as Element;

  Array.from(clone.querySelectorAll("input")).forEach((input, index) => {
    if (privateFields[index]) {
      input.removeAttribute("value");
    }
  });

  const context: SanitizeContext = {
    options,
    sensitiveNameParts: [
      ...SENSITIVE_ATTRIBUTE_NAME_PARTS,
      ...(options.sensitiveNamePatterns ?? []).map((pattern) => pattern.toLowerCase())
    ].filter((part) => part.length > 0)
  };

  if (!sanitizeTree(clone, context)) {
    return null;
  }

  // `designMode` makes the whole page an editor without any attribute to find.
  if (document.designMode === "on" && !options.keepInputValues) {
    clone.querySelector("body")?.replaceChildren(document.createTextNode(MASKED_TEXT));
  }

  const doctype = document.doctype ? `<!DOCTYPE ${document.doctype.name}>` : "";
  const html = `${doctype}${clone.outerHTML}`;

  return {
    html: html.slice(0, RAW_DOM_SNAPSHOT_MAX_CHARS),
    htmlLength: html.length,
    truncated: html.length > RAW_DOM_SNAPSHOT_MAX_CHARS
  };
}

/** Sanitizes a subtree and every `<template>` content inside it; false on an invalid selector. */
function sanitizeTree(root: Element | DocumentFragment, context: SanitizeContext): boolean {
  for (const element of Array.from(root.querySelectorAll(DROPPED_SELECTOR))) {
    element.remove();
  }

  removeComments(root);

  if (!maskBlockedElements(root, context.options.blockedSelectors)) {
    return false;
  }

  const elements = [
    ...(root instanceof Element ? [root] : []),
    ...Array.from(root.querySelectorAll("*"))
  ];

  for (const element of elements) {
    sanitizeAttributes(element, context);
  }

  stripFieldValues(root, context.options.keepInputValues);

  return Array.from(root.querySelectorAll("template")).every((template) =>
    sanitizeTree(template.content, context)
  );
}

function removeComments(root: Element | DocumentFragment): void {
  const ownerDocument = root.ownerDocument ?? document;
  const walker = ownerDocument.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];

  while (walker.nextNode()) {
    comments.push(walker.currentNode);
  }

  for (const comment of comments) {
    comment.parentNode?.removeChild(comment);
  }
}

function maskBlockedElements(
  root: Element | DocumentFragment,
  selectors: readonly string[]
): boolean {
  const blocked: Element[] = [];

  for (const selector of selectors) {
    try {
      if (root instanceof Element && root.matches(selector)) {
        blocked.push(root);
      }

      blocked.push(...Array.from(root.querySelectorAll(selector)));
    } catch {
      return false;
    }
  }

  // Tracked here, not by attribute: a page could forge the marker to skip masking.
  const masked = new Set<Element>();

  for (const element of blocked) {
    if (masked.has(element)) {
      continue;
    }

    masked.add(element);

    for (const attribute of Array.from(element.attributes)) {
      if (!MASKED_KEPT_ATTRIBUTES.has(attribute.name)) {
        element.removeAttribute(attribute.name);
      }
    }

    element.setAttribute(MASKED_ATTRIBUTE, "true");
    element.replaceChildren(element.ownerDocument.createTextNode(MASKED_TEXT));
  }

  return true;
}

function sanitizeAttributes(element: Element, context: SanitizeContext): void {
  const isMeta = element.tagName === "META";
  const metaName = (
    element.getAttribute("name") ??
    element.getAttribute("property") ??
    ""
  ).toLowerCase();

  for (const attribute of Array.from(element.attributes)) {
    // `localName` drops namespace prefixes (`xlink:href` → `href`).
    const name = attribute.localName.toLowerCase();

    if (DROPPED_ATTRIBUTES.has(name) || isEventHandlerAttribute(element, name)) {
      element.removeAttributeNode(attribute);
    } else if (isMeta && name === "content" && !KEPT_META_NAMES.has(metaName)) {
      element.removeAttributeNode(attribute);
    } else if (URL_ATTRIBUTES.has(name)) {
      attribute.value = sanitizeUrlForPrivacy(attribute.value);
    } else if (name === "srcset" || name === "imagesrcset") {
      attribute.value = sanitizeSrcset(attribute.value);
    } else if (
      hasSensitiveNamePart(name, context.sensitiveNameParts) ||
      (name !== "class" && isSecretValue(attribute.value))
    ) {
      attribute.value = MASKED_TEXT;
    } else if (name === "style" || /url\(/i.test(attribute.value)) {
      // Inline CSS and SVG paint attributes (`fill="url(…)"`, `mask`, `filter`…).
      attribute.value = sanitizeCssUrls(attribute.value);
    } else if (URL_SHAPED_VALUE_PATTERN.test(attribute.value.trim())) {
      // Lazy-load and legacy URL attributes (`data-src`, `data-bg`, `longdesc`…).
      attribute.value = sanitizeUrlForPrivacy(attribute.value.trim());
    }
  }

  if (element.localName === "style" && element.textContent) {
    element.textContent = sanitizeCssUrls(element.textContent);
  }
}

/** `onclick`, `onerror`…: only names the element knows as handlers (`one` is kept). */
function isEventHandlerAttribute(element: Element, name: string): boolean {
  return /^on[a-z]+$/.test(name) && name in element;
}

/**
 * Attribute names are lowercased by HTML, so words run together (`data-csrftoken`): parts match
 * the name without separators, except short ones that hide in other words (`otp` in
 * `data-hotpath`), which must be a whole word.
 */
function hasSensitiveNamePart(name: string, parts: readonly string[]): boolean {
  const words = name.split(/[-_:.]+/);
  const collapsed = words.join("");

  return parts.some((part) => {
    const collapsedPart = part.replace(/[-_:.\s]+/g, "");
    return WORD_ONLY_NAME_PARTS.has(collapsedPart)
      ? words.includes(collapsedPart)
      : collapsed.includes(collapsedPart);
  });
}

function isSecretValue(value: string): boolean {
  return (
    CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value)) ||
    (/^\s*[[{]/.test(value) && JSON_SECRET_KEY_PATTERN.test(value))
  );
}

/**
 * Runs every CSS URL (`url(…)`, quoted or not, and quoted URL strings such as `@import "…"` or
 * `image-set("…")`) through the same sanitizer as recorded URLs, keeping all other CSS text as
 * it is. A hand-written scanner that reads each character once, so adversarial styles cannot
 * slow it down. Comments and anything left unterminated fall back to stripping every `?…`
 * query, so a stray quote or `url(` never lets a later URL through. `data:` URLs are kept.
 */
function sanitizeCssUrls(css: string): string {
  const chunks: string[] = [];
  let index = 0;
  let copiedUpTo = 0;
  const copyTo = (end: number): void => {
    chunks.push(css.slice(copiedUpTo, end));
    copiedUpTo = end;
  };
  const stripRest = (): void => {
    chunks.push(stripCssQueries(css.slice(copiedUpTo)));
    copiedUpTo = css.length;
    index = css.length;
  };

  while (index < css.length) {
    const char = css[index];

    if (char === "/" && css[index + 1] === "*") {
      const close = css.indexOf("*/", index + 2);
      const end = close === -1 ? css.length : close + 2;
      copyTo(index);
      chunks.push(stripCssQueries(css.slice(index, end)));
      copiedUpTo = end;
      index = end;
    } else if (
      (char === "u" || char === "U") &&
      css.slice(index, index + 4).toLowerCase() === "url("
    ) {
      const url = findCssUrl(css, index + 4);

      if (!url) {
        copyTo(index);
        stripRest();
      } else {
        copyTo(url.start);
        chunks.push(sanitizeCssUrl(css.slice(url.start, url.end)));
        copiedUpTo = url.end;
        index = url.end;
      }
    } else if (char === "\\") {
      // An escape outside strings (`.content-\[\'\'\]`) is never a string delimiter.
      index += 2;
    } else if (char === '"' || char === "'") {
      const end = findQuoteEnd(css, index + 1, char);

      if (end >= css.length) {
        copyTo(index);
        stripRest();
      } else {
        const text = css.slice(index + 1, end);

        if (CSS_URL_STRING_PATTERN.test(text)) {
          copyTo(index + 1);
          chunks.push(sanitizeCssUrl(text));
          copiedUpTo = end;
        }

        index = end + 1;
      }
    } else {
      index += 1;
    }
  }

  copyTo(css.length);
  return chunks.join("");
}

/**
 * Bounds of the URL inside `url(` (without its quotes), or null when it is unterminated. An
 * unquoted URL ends at whitespace, a quote or an unescaped `)` that closes it; parentheses
 * inside are balanced and backslash escapes are skipped.
 */
function findCssUrl(css: string, start: number): { start: number; end: number } | null {
  let index = start;

  while (index < css.length && /\s/.test(css[index] ?? "")) {
    index += 1;
  }

  const quote = css[index];

  if (quote === '"' || quote === "'") {
    const end = findQuoteEnd(css, index + 1, quote);
    return end >= css.length ? null : { start: index + 1, end };
  }

  let depth = 0;

  for (let cursor = index; cursor < css.length; cursor += 1) {
    const char = css[cursor] ?? "";

    if (char === "\\") {
      cursor += 1;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")" && depth > 0) {
      depth -= 1;
    } else if (char === ")" || /[\s"']/.test(char)) {
      return { start: index, end: cursor };
    }
  }

  return null;
}

function findQuoteEnd(css: string, start: number, quote: string): number {
  let index = start;

  while (index < css.length && css[index] !== quote) {
    index += css[index] === "\\" ? 2 : 1;
  }

  return Math.min(index, css.length);
}

/** A URL query anywhere in CSS text; the fallback for comments and unterminated text. */
function stripCssQueries(css: string): string {
  return css.replace(CSS_QUERY_PATTERN, "");
}

function sanitizeCssUrl(url: string): string {
  if (/^\s*(?:data:|#)/i.test(url)) {
    return url;
  }

  // A trailing backslash would escape the closing quote or paren once the query is gone.
  return stripCssQueries(sanitizeUrlForPrivacy(url.trim())).replace(/\\+$/, "");
}

function sanitizeSrcset(value: string): string {
  return value
    .split(",")
    .map((candidate) => {
      const [url = "", ...descriptors] = candidate.trim().split(/\s+/);
      return [sanitizeUrlForPrivacy(url), ...descriptors].join(" ");
    })
    .join(", ");
}

function stripFieldValues(root: Element | DocumentFragment, keepInputValues: boolean): void {
  for (const input of Array.from(root.querySelectorAll("input"))) {
    const type = (input.getAttribute("type") ?? "").toLowerCase();

    if (!keepInputValues || type === "hidden" || isNeverCapturedField(input)) {
      input.removeAttribute("value");
    }
  }

  for (const textarea of Array.from(root.querySelectorAll("textarea"))) {
    if (!keepInputValues || isNeverCapturedField(textarea)) {
      textarea.textContent = "";
    }
  }

  if (keepInputValues) {
    return;
  }

  // Rich editors hold typed text (chat, mail); without input values it is masked like a field.
  const editorSelector = '[contenteditable]:not([contenteditable="false"])';
  const editors = [
    ...(root instanceof Element && root.matches(editorSelector) ? [root] : []),
    ...Array.from(root.querySelectorAll(editorSelector))
  ];

  for (const editor of editors) {
    editor.replaceChildren(editor.ownerDocument.createTextNode(MASKED_TEXT));
  }

  for (const element of Array.from(root.querySelectorAll("[value]"))) {
    if (VALUE_ATTRIBUTE_ELEMENTS.has(element.tagName)) {
      element.removeAttribute("value");
    }
  }
}
