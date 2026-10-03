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
  "apikey",
  "api_key"
];
/** Parts that are several words run together; matched without separators. */
const COMPOUND_NAME_PARTS = new Set(["apikey", "accesskey", "privatekey", "authkey"]);
const CSS_URL_PATTERN = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
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
    } else if (name === "style") {
      attribute.value = sanitizeCssUrls(attribute.value);
    } else if (hasSensitiveNameWord(name, context.sensitiveNameParts)) {
      attribute.value = MASKED_TEXT;
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
 * Single-word parts match whole words of the name (`data-session-id`, not `data-hotpath`);
 * compound parts (`api_key`, `apikey`) match the name with its separators removed.
 */
function hasSensitiveNameWord(name: string, parts: readonly string[]): boolean {
  const words = name.split(/[-_:.]+/);
  const collapsed = words.join("");

  return parts.some((part) => {
    const collapsedPart = part.replace(/[-_:.\s]+/g, "");
    return COMPOUND_NAME_PARTS.has(collapsedPart) || collapsedPart !== part
      ? collapsed.includes(collapsedPart)
      : words.includes(part);
  });
}

function sanitizeCssUrls(css: string): string {
  return css.replace(CSS_URL_PATTERN, (match, quote: string, url: string) =>
    url.startsWith("data:") ? match : `url(${quote}${sanitizeUrlForPrivacy(url)}${quote})`
  );
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

  for (const element of Array.from(root.querySelectorAll("[value]"))) {
    if (VALUE_ATTRIBUTE_ELEMENTS.has(element.tagName)) {
      element.removeAttribute("value");
    }
  }
}
