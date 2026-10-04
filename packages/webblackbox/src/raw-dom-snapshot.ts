import { sanitizeUrlForPrivacy } from "@webblackbox/protocol";
import {
  isContentRedactionEnabled,
  maskValuePatterns,
  recordUrl,
  usesBuiltInHeuristics,
  type RedactionRules
} from "@webblackbox/protocol/redaction-rules";
import {
  containsCredential,
  mentionsSecretName,
  redactCredentials,
  unescapeForScan
} from "@webblackbox/protocol/secret-detection";

import { isNeverCapturedField } from "./input-value-policy.js";

/** Longest raw DOM snapshot kept, in characters (the materializer also caps the bytes). */
export const RAW_DOM_SNAPSHOT_MAX_CHARS = 1_000_000;

const MASKED_TEXT = "[REDACTED]";
const MASKED_ATTRIBUTE = "data-webblackbox-masked";
/** Attributes a masked element keeps, so the page layout still reads. */
const MASKED_KEPT_ATTRIBUTES = new Set(["class", "style"]);
/**
 * Never written: code (and secrets inlined in it), noscript markup, the extension's own UI, and
 * raw-text elements whose text the serializer writes unescaped.
 */
const DROPPED_SELECTOR =
  "script, noscript, xmp, noembed, noframes, plaintext, [data-webblackbox-indicator]";
/** The extension's own UI: never part of the page, whatever the rules. */
const OWN_UI_SELECTOR = "[data-webblackbox-indicator]";
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
  "ping",
  "longdesc",
  "lowsrc",
  "manifest",
  "codebase",
  "itemid"
]);
/** Attributes never written: inline documents. Event handler attributes (`on*`) are dropped too. */
const DROPPED_ATTRIBUTES = new Set(["srcdoc"]);
/** `<meta>` whose `content` is kept; others (CSRF tokens, verification codes…) lose it. */
const KEPT_META_NAMES = new Set(["viewport", "theme-color", "color-scheme", "description"]);
/** An attribute value that is a URL on its own (`data-src`, `data-bg`…). */
const URL_SHAPED_VALUE_PATTERN = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|\/[^\s/]|\.\.?\/)\S*$/i;
/** Elements whose `value` attribute is form data (inputs are handled field by field). */
const VALUE_ATTRIBUTE_ELEMENTS = new Set(["BUTTON", "OPTION", "PARAM", "DATA", "METER"]);

/**
 * Fidelity pass over CSS, one token at a time: escapes, comments and strings are skipped whole
 * (so a quote inside them never shifts the scan), `url(…)` and URL strings are sanitized like
 * recorded URLs. Every alternative always matches, so the scan is linear. Safety does not depend
 * on it: {@link enforceCssInvariant} runs afterwards on the whole text.
 */
const CSS_TOKEN_PATTERN =
  /\\[\s\S]|\/\*[\s\S]*?(?:\*\/|$)|url\(\s*(?:"(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?|(?:\\[\s\S]|[^\s"'()\\])*)\s*\)?|"(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?/gi;
/**
 * `?` and what follows up to a delimiter, escapes included (`\?token\=x` in a Tailwind class).
 * Parentheses and commas belong to the run: it only meets text the token pass did not sanitize
 * (comments, selectors, malformed URLs), where `?q=(1)&token=…` must go whole.
 */
const CSS_QUERY_RUN_PATTERN = /\\?\?(?:\\[\s\S]|[^\s"'`;{}<>\\])+/g;
/**
 * `#key=…`: a token fragment, not a colour or an id selector (`#app[data-state=open]` keeps its
 * attribute selector: the key holds only name characters). Linear: keys stop at the next `#`.
 */
const CSS_FRAGMENT_RUN_PATTERN = /\\?#(?:\\[^#]|[\w.%&-])*=(?:\\[\s\S]|[^\s"'`;{}<>\\])*/g;
/** What an escape-decoded CSS text may not contain once the invariant ran. */
const CSS_LEFTOVER_QUERY_PATTERN = /\?[^\s"'`;{}<>]|#[\w.%&-]*=/;
const CSS_ESCAPE_PATTERN = /\\(?:([0-9a-fA-F]{1,6})[ \t\r\n\f]?|([\s\S]))/g;
/** Credentials inside CSS become an identifier, so selectors and values stay parseable. */
const CSS_REDACTED = "redacted";
/** Written instead of style text that is still suspicious after sanitizing. */
const CSS_DROPPED = "/* [REDACTED] */";
/**
 * A `key=value` query (`?…=…`) or fragment (`#…=…`) anywhere in an attribute value or text, URL
 * or not (`a.html?code=…`). Bare queries are handled by {@link URL_SUFFIX_PATTERN}.
 */
const QUERY_PARAMETER_PATTERN = /[?#][^\s"'`<>?#=]*=[^\s"'`<>]*/g;
/**
 * A URL in text (`https://…`, or a path starting `/` after a space or quote) and its query,
 * fragment or path parameters (`?TOKEN`, `#TOKEN`, `;jsessionid=…`), which are dropped. The
 * suffix is optional so every match succeeds and the scan never restarts inside a path.
 */
const URL_SUFFIX_PATTERN =
  /((?:\b[a-z][a-z0-9+.-]{0,30}:\/\/|(?<![\w/.~-])\/)[^\s"'`<>?#;]*)(?:[?#;][^\s"'`<>]*)?/gi;
/** `--api-token: …`: a custom property named like a secret; its value is replaced. */
const CSS_CUSTOM_PROPERTY_PATTERN = /(?<![\w-])(--[\w-]+)(\s*:)[^;}]*/g;
/** `scheme://user:password@host`: the credentials go, the URL stays. */
// Up to the last `@` before the path: a password may hold `@` itself.
const URL_USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/?#"'`<>]*@/gi;
// Without `g`: `test` on a global pattern keeps `lastIndex` between calls.
const HAS_URL_USERINFO_PATTERN = new RegExp(URL_USERINFO_PATTERN.source, "i");

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
  /** The profile's redaction rules: masking switch, built-in heuristics, DOM value patterns. */
  redaction?: RedactionRules;
};

type SanitizeContext = {
  options: RawDomSnapshotOptions;
  rules: RedactionRules;
  /** The profile's body patterns, matched on attribute names besides the shared secret names. */
  extraNameParts: readonly string[];
};

/**
 * The page as HTML for `dom: allow`. Works on a detached clone, so the page is never touched.
 * The HTML is stored as a blob the recorder's redactor never sees, so the profile's redaction
 * rules are applied here, best effort:
 *
 * - masking off (`contentRedaction: false`): the page as it is, minus the extension's own UI
 *   and any blocked selectors the profile keeps;
 * - user rules only (`builtInHeuristics: false`): blocked selectors, field values, URL query
 *   parameter rules and DOM value patterns;
 * - with the built-in heuristics (the default), fail closed:
 *
 * - blocked selectors, field values, editors, code, comments and inline documents are removed;
 * - every attribute value, text node and style text then goes through a context-free pass that
 *   strips URL queries, token fragments and URL credentials and masks credential-shaped tokens,
 *   whatever element or position it sits in;
 * - style text that still looks suspicious once its CSS escapes are decoded is dropped whole.
 *
 * Returns null when a blocked selector is invalid: without it nothing proves the blocked content
 * is masked, so the caller records a summary (fail closed).
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
  const rules = options.redaction;
  const privateFields = Array.from(root.querySelectorAll("input"), (input) =>
    isNeverCapturedField(input, rules)
  );
  const clone = root.cloneNode(true) as Element;

  Array.from(clone.querySelectorAll("input")).forEach((input, index) => {
    if (privateFields[index]) {
      input.removeAttribute("value");
    }
  });

  const context: SanitizeContext = {
    options,
    rules,
    extraNameParts: (options.sensitiveNamePatterns ?? []).filter((part) => part.length > 0)
  };
  // The single switch of the raw DOM: which rule set runs on the clone.
  const applied = !isContentRedactionEnabled(rules)
    ? keepAsCaptured(clone, context)
    : usesBuiltInHeuristics(rules)
      ? sanitizeTree(clone, context)
      : applyUserRules(clone, context);

  if (!applied) {
    return null;
  }

  // `designMode` makes the whole page an editor without any attribute to find. The inputs
  // category decides this, whatever the masking rules.
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

  // Fallback text of a frame is written raw, like a script.
  for (const frame of Array.from(root.querySelectorAll("iframe"))) {
    frame.replaceChildren();
  }

  removeComments(root);

  if (!maskBlockedElements(root, context.options.blockedSelectors)) {
    return false;
  }

  stripFieldValues(root, context);

  const elements = [
    ...(root instanceof Element ? [root] : []),
    ...Array.from(root.querySelectorAll("*"))
  ];

  for (const element of elements) {
    sanitizeAttributes(element, context);
  }

  sanitizeTextNodes(root, context);

  return Array.from(root.querySelectorAll("template")).every((template) =>
    sanitizeTree(template.content, context)
  );
}

/**
 * Masking off: the extension's own UI and the blocked selectors the profile keeps are removed,
 * and field values follow the inputs category (masking never widens a category).
 */
function keepAsCaptured(root: Element, context: SanitizeContext): boolean {
  for (const element of Array.from(root.querySelectorAll(OWN_UI_SELECTOR))) {
    element.remove();
  }

  if (!maskBlockedElements(root, context.options.blockedSelectors)) {
    return false;
  }

  stripFieldValues(root, context);
  return true;
}

/**
 * The user's rules without the built-in heuristics: blocked selectors, field values, URL query
 * parameter rules in URL attributes, and DOM value patterns in attribute values and text.
 */
function applyUserRules(root: Element | DocumentFragment, context: SanitizeContext): boolean {
  for (const element of Array.from(root.querySelectorAll(OWN_UI_SELECTOR))) {
    element.remove();
  }

  if (!maskBlockedElements(root, context.options.blockedSelectors)) {
    return false;
  }

  stripFieldValues(root, context);

  const elements = [
    ...(root instanceof Element ? [root] : []),
    ...Array.from(root.querySelectorAll("*"))
  ];

  for (const element of elements) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.localName.toLowerCase();
      const value = URL_ATTRIBUTES.has(name)
        ? recordUrl(attribute.value, context.rules)
        : attribute.value;
      attribute.value = maskValuePatterns(value, context.rules, "dom");
    }
  }

  for (const node of collectNodes(root, NodeFilter.SHOW_TEXT)) {
    const text = node.nodeValue ?? "";
    const masked = maskValuePatterns(text, context.rules, "dom");

    if (masked !== text) {
      node.nodeValue = masked;
    }
  }

  return Array.from(root.querySelectorAll("template")).every((template) =>
    applyUserRules(template.content, context)
  );
}

function removeComments(root: Element | DocumentFragment): void {
  for (const comment of collectNodes(root, NodeFilter.SHOW_COMMENT)) {
    comment.parentNode?.removeChild(comment);
  }
}

function collectNodes(root: Element | DocumentFragment, filter: number): Node[] {
  const ownerDocument = root.ownerDocument ?? document;
  const walker = ownerDocument.createTreeWalker(root, filter);
  const nodes: Node[] = [];

  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
  }

  return nodes;
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
  for (const attribute of Array.from(element.attributes)) {
    // `localName` drops namespace prefixes (`xlink:href` → `href`).
    const name = attribute.localName.toLowerCase();

    if (isDroppedAttribute(element, name)) {
      element.removeAttributeNode(attribute);
    } else {
      attribute.value = maskValuePatterns(
        sanitizeAttributeValue(name, attribute.value, context),
        context.rules,
        "dom"
      );
    }
  }

  if (element.localName === "style" && element.textContent) {
    element.textContent = maskValuePatterns(sanitizeCss(element.textContent), context.rules, "dom");
  }
}

/** Inline documents, event handlers and `<meta content>` other than a few display hints. */
function isDroppedAttribute(element: Element, name: string): boolean {
  // Every handler name, known to the element or not (`onfocusin`), but not `one`.
  if (DROPPED_ATTRIBUTES.has(name) || /^on[a-z]{3,}$/.test(name)) {
    return true;
  }

  if (element.localName !== "meta" || name !== "content") {
    return false;
  }

  const metaName = (
    element.getAttribute("name") ??
    element.getAttribute("property") ??
    ""
  ).toLowerCase();

  // `http-equiv="refresh"` carries a URL whatever `name` says.
  return !KEPT_META_NAMES.has(metaName) || element.hasAttribute("http-equiv");
}

function sanitizeAttributeValue(name: string, value: string, context: SanitizeContext): string {
  if (mentionsSecretName(name, context.extraNameParts) || isSecretJson(value, context)) {
    return MASKED_TEXT;
  }

  if (name === "style" || /url\(/i.test(value)) {
    // Inline CSS and SVG paint attributes (`fill="url(…)"`, `mask`, `filter`…).
    return enforceTextInvariant(sanitizeCss(value), MASKED_TEXT, true);
  }

  // Queries go before URLs are split or templated: `srcset="/a.png?a=1,b 1x"` holds one query.
  const withoutQueries = value.replace(QUERY_PARAMETER_PATTERN, "");
  return enforceTextInvariant(normalizeUrls(name, withoutQueries), MASKED_TEXT, true);
}

/** JSON page state (`data-props='{"auth":{"sid":…}}'`, `<pre>{…}</pre>`) naming a secret field. */
function isSecretJson(text: string, context: SanitizeContext): boolean {
  return /^\s*[[{]/.test(text) && mentionsSecretName(unescapeForScan(text), context.extraNameParts);
}

/** URL attributes and URL-shaped values (`data-src`) are sanitized like every recorded URL. */
function normalizeUrls(name: string, value: string): string {
  if (URL_ATTRIBUTES.has(name)) {
    // `href="#icon"` (SVG sprites, in-page links) points inside the document, not to a server.
    return /^#[\w.:-]*$/.test(value.trim()) ? value : sanitizeUrlForPrivacy(value);
  }

  if (name === "srcset" || name === "imagesrcset") {
    return sanitizeSrcset(value);
  }

  return URL_SHAPED_VALUE_PATTERN.test(value.trim()) ? sanitizeUrlForPrivacy(value.trim()) : value;
}

/**
 * The context-free guarantee for attribute values and text: URL queries, token fragments and
 * URL credentials are stripped wherever they appear, and credential-shaped tokens are masked
 * (the whole value for an attribute, only the token for text).
 */
function enforceTextInvariant(text: string, replacement: string, maskWhole: boolean): string {
  if (maskWhole && containsCredential(text)) {
    return replacement;
  }

  const stripped = text
    .replace(QUERY_PARAMETER_PATTERN, "")
    .replace(URL_SUFFIX_PATTERN, "$1")
    .replace(URL_USERINFO_PATTERN, "$1");
  return maskWhole ? stripped : redactCredentials(stripped, replacement);
}

/** Visible text keeps its words; URLs lose their queries and credentials are masked. */
function sanitizeTextNodes(root: Element | DocumentFragment, context: SanitizeContext): void {
  for (const node of collectNodes(root, NodeFilter.SHOW_TEXT)) {
    if (node.parentElement?.localName === "style") {
      continue;
    }

    const text = node.nodeValue ?? "";
    const sanitized = isSecretJson(text, context)
      ? MASKED_TEXT
      : maskValuePatterns(enforceTextInvariant(text, MASKED_TEXT, false), context.rules, "dom");

    if (sanitized !== text) {
      node.nodeValue = sanitized;
    }
  }
}

/**
 * Inline CSS and `<style>` text. The token pass sanitizes well-formed URLs like recorded URLs;
 * {@link enforceCssInvariant} then removes every query, token fragment, URL credential and
 * credential-shaped token from the whole text, so a scanner desync cannot let one through. If
 * the text, with its CSS escapes decoded, still holds any of them (`\3f token\3d …`), it is
 * dropped whole.
 */
export function sanitizeCss(css: string): string {
  const withUrls = css.replace(CSS_TOKEN_PATTERN, sanitizeCssToken);
  // `</style` inside style text would end the element in the stored HTML.
  const cleaned = enforceCssInvariant(withUrls).replace(/<\//g, "<\\/");
  const decoded = cleaned.replace(CSS_ESCAPE_PATTERN, decodeCssEscape);

  return CSS_LEFTOVER_QUERY_PATTERN.test(decoded) ||
    HAS_URL_USERINFO_PATTERN.test(decoded) ||
    containsCredential(decoded)
    ? CSS_DROPPED
    : cleaned;
}

function sanitizeCssToken(token: string): string {
  const quote = token[0];

  if (quote === '"' || quote === "'") {
    const closed = token.length > 1 && token.endsWith(quote);
    const text = token.slice(1, closed ? -1 : undefined);

    // An unterminated string is left whole for the invariant, which strips it to the end.
    return closed && isCssUrlString(text) ? `${quote}${sanitizeCssUrl(text)}${quote}` : token;
  }

  if (!/^url\(/i.test(token)) {
    return token;
  }

  // Split by hand: a regex with a lazy body and an optional close backtracks on long data URLs.
  const afterOpen = token.slice("url(".length);
  const body = afterOpen.trimStart();
  if (!body.endsWith(")")) {
    // Malformed (`url(/a.png?q=(1)&t=…)`): left whole, so the invariant strips the query.
    return token;
  }

  const value = body.slice(0, -1).trimEnd();
  const tail = body.slice(value.length);
  const head = token.slice(0, token.length - body.length);
  const valueQuote = value[0] === '"' || value[0] === "'" ? value[0] : "";

  if (valueQuote && (value.length < 2 || !value.endsWith(valueQuote))) {
    return token;
  }

  const url = valueQuote ? value.slice(1, -1) : value;
  return `${head}${valueQuote}${sanitizeCssUrl(url)}${valueQuote}${tail}`;
}

/**
 * A CSS string that is a URL or a reference: `@import "/x.css"`, `image-set("a.png" 1x)`,
 * `"page#ref"`, `"x?y"`. Plain checks, no backtracking pattern: strings are page-controlled.
 */
function isCssUrlString(text: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\S*$/i.test(text)) {
    return true;
  }

  return (
    !/[\s"']/.test(text) &&
    (/^\.{0,2}\//.test(text) || /\.[a-z0-9]{2,5}(?:[?#]|$)/i.test(text) || /[?#]./.test(text))
  );
}

function sanitizeCssUrl(url: string): string {
  // `url(#gradient)`: a reference inside the document, not a request.
  if (/^\s*#/.test(url)) {
    return url;
  }

  // A trailing backslash would escape the closing quote or paren once the query is gone.
  return sanitizeUrlForPrivacy(url.trim()).replace(/\\+$/, "");
}

function enforceCssInvariant(css: string): string {
  const stripped = css
    .replace(CSS_QUERY_RUN_PATTERN, "")
    .replace(CSS_FRAGMENT_RUN_PATTERN, "")
    .replace(URL_USERINFO_PATTERN, "$1")
    .replace(CSS_CUSTOM_PROPERTY_PATTERN, (declaration, name: string, colon: string) =>
      mentionsSecretName(name) ? `${name}${colon} ${CSS_REDACTED}` : declaration
    );

  return redactCredentials(stripped, CSS_REDACTED);
}

function decodeCssEscape(
  _match: string,
  hex: string | undefined,
  char: string | undefined
): string {
  if (hex === undefined) {
    return char ?? "";
  }

  const codePoint = Number.parseInt(hex, 16);
  return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "�";
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

function stripFieldValues(root: Element | DocumentFragment, context: SanitizeContext): void {
  const { keepInputValues } = context.options;

  for (const input of Array.from(root.querySelectorAll("input"))) {
    // HTML does not trim `type`: `"hidden "` is a text field, but its value is still form state.
    const type = (input.getAttribute("type") ?? "").trim().toLowerCase();

    if (!keepInputValues || type === "hidden" || isNeverCapturedField(input, context.rules)) {
      input.removeAttribute("value");
    }
  }

  for (const textarea of Array.from(root.querySelectorAll("textarea"))) {
    if (!keepInputValues || isNeverCapturedField(textarea, context.rules)) {
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
