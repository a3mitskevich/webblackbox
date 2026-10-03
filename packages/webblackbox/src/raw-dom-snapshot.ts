import { isNeverCapturedField } from "./input-value-policy.js";

/** Longest raw DOM snapshot kept, in characters (the materializer also caps the bytes). */
export const RAW_DOM_SNAPSHOT_MAX_CHARS = 1_000_000;

const MASKED_TEXT = "[REDACTED]";
const MASKED_ATTRIBUTE = "data-webblackbox-masked";
/** Attributes a masked element keeps, so the page layout still reads. */
const MASKED_KEPT_ATTRIBUTES = new Set(["class", "style"]);
/** Elements never written: code (and secrets inlined in it) and the extension's own UI. */
const DROPPED_SELECTOR = "script, [data-webblackbox-indicator]";

export type RawDomSnapshot = {
  html: string;
  htmlLength: number;
  truncated: boolean;
};

export type RawDomSnapshotOptions = {
  /** Elements whose content (and descendants) is replaced by a mask. */
  blockedSelectors: readonly string[];
  /** Keep `value` attributes and textarea text (`inputs: allow`); never for passwords or hidden fields. */
  keepInputValues: boolean;
};

/**
 * The page as HTML for `dom: allow`. Works on a detached clone, so the page is never touched.
 * Returns null when a blocked selector is invalid: without it nothing proves the blocked
 * content is masked, so the caller records a summary instead (fail closed).
 */
export function serializeRawDom(
  document: Document,
  options: RawDomSnapshotOptions
): RawDomSnapshot | null {
  const root = document.documentElement;

  if (!root) {
    return null;
  }

  const clone = root.cloneNode(true) as Element;

  for (const element of Array.from(clone.querySelectorAll(DROPPED_SELECTOR))) {
    element.remove();
  }

  if (!maskBlockedElements(clone, options.blockedSelectors)) {
    return null;
  }

  stripFieldValues(clone, options.keepInputValues);

  const doctype = document.doctype ? `<!DOCTYPE ${document.doctype.name}>` : "";
  const html = `${doctype}${clone.outerHTML}`;

  return {
    html: html.slice(0, RAW_DOM_SNAPSHOT_MAX_CHARS),
    htmlLength: html.length,
    truncated: html.length > RAW_DOM_SNAPSHOT_MAX_CHARS
  };
}

function maskBlockedElements(clone: Element, selectors: readonly string[]): boolean {
  const blocked: Element[] = [];

  for (const selector of selectors) {
    try {
      if (clone.matches(selector)) {
        blocked.push(clone);
      }

      blocked.push(...Array.from(clone.querySelectorAll(selector)));
    } catch {
      return false;
    }
  }

  for (const element of blocked) {
    if (element.hasAttribute(MASKED_ATTRIBUTE)) {
      continue;
    }

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

function stripFieldValues(clone: Element, keepInputValues: boolean): void {
  for (const input of Array.from(clone.querySelectorAll("input"))) {
    const type = (input.getAttribute("type") ?? "").toLowerCase();

    if (!keepInputValues || type === "hidden" || isNeverCapturedField(input)) {
      input.removeAttribute("value");
    }
  }

  if (!keepInputValues) {
    for (const textarea of Array.from(clone.querySelectorAll("textarea"))) {
      textarea.textContent = "";
    }
  }
}
