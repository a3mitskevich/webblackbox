import {
  isContentRedactionEnabled,
  maskDomText,
  RRWEB_EVENT_TYPES,
  RRWEB_INCREMENTAL_SOURCES,
  usesBuiltInHeuristics,
  type CapturePolicy,
  type RrwebRecordedEvent
} from "@webblackbox/protocol";

import {
  isDroppedRawDomAttribute,
  sanitizeCss,
  sanitizeRawDomAttribute,
  sanitizeRawDomText
} from "./raw-dom-snapshot.js";

/**
 * Masking rrweb cannot do itself (spike, task 56). rrweb masks text nodes and field values; the
 * rules below bring the rest of what it records (attribute values, style text, rich editors,
 * hidden fields) to what `serializeRawDom` records for the same policy, so a profile masks the
 * same values whichever DOM recorder runs.
 */

/** rrweb `IncrementalSource.Input`: a field value change. */
const INPUT_SOURCE = 5;
/** rrweb `IncrementalSource` values that carry CSS text written through the CSSOM. */
const STYLE_SHEET_RULE_SOURCE = 8;
const STYLE_DECLARATION_SOURCE = 13;
const ADOPTED_STYLE_SHEET_SOURCE = 15;
/** rrweb-snapshot `NodeType` values. */
const ELEMENT_NODE = 2;
const TEXT_NODE = 3;
/** Rich editors hold typed text (chat, mail): masked like a field unless inputs are recorded. */
const EDITOR_SELECTOR = '[contenteditable]:not([contenteditable="false"])';
/** Attributes that carry page text: `dom: masked` masks them like text nodes. */
const TEXT_ATTRIBUTES = new Set([
  "title",
  "alt",
  "placeholder",
  "label",
  "summary",
  "abbr",
  "content",
  "download",
  "srcdoc",
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext"
]);
/** Elements whose `value` attribute is form data (fields go through rrweb's `maskInputFn`). */
const VALUE_ATTRIBUTE_TAGS = new Set(["button", "option", "param", "data", "meter"]);

type Attributes = Record<string, unknown>;
/** The live node behind an rrweb node id (rrweb's mirror), or null. */
export type RrwebNodeLookup = (id: number) => Node | null;
export type RrwebTextMask = (text: string, element: HTMLElement | null) => string;

type MaskContext = {
  policy: CapturePolicy;
  masksAllText: boolean;
  masksFieldValues: boolean;
  redacts: boolean;
  heuristics: boolean;
  extraNameParts: readonly string[];
};

const maskAll = (text: string): string => text.replace(/\S/g, "*");

function contextOf(policy: CapturePolicy): MaskContext {
  const { dom, inputs } = policy.categories;
  const redacts = isContentRedactionEnabled(policy.redaction);

  return {
    policy,
    masksAllText: dom === "masked" || dom === "wireframe",
    masksFieldValues: inputs !== "allow",
    redacts,
    heuristics: redacts && usesBuiltInHeuristics(policy.redaction),
    extraNameParts: (policy.redaction.redactBodyPatterns ?? []).filter((part) => part.length > 0)
  };
}

/**
 * Text that is a field value: a rich editor's, or a `<textarea>`'s default text (rrweb writes it
 * as a text node when the field is empty, without `maskInputFn`).
 */
function isFieldText(element: HTMLElement | null): boolean {
  return (
    element !== null &&
    (element.closest(`${EDITOR_SELECTOR}, textarea`) !== null ||
      element.ownerDocument.designMode === "on")
  );
}

/**
 * rrweb's `maskTextFn` for a policy, or null when text is recorded as it is. rrweb calls it for
 * text nodes under `maskTextSelector`; style text keeps its rules (masking it would break the
 * replay), with the built-in heuristics applied as in the raw DOM.
 */
export function buildRrwebTextMask(policy: CapturePolicy): RrwebTextMask | null {
  const context = contextOf(policy);
  const hasDomPatterns = (policy.redaction.valuePatterns ?? []).some((rule) =>
    rule.targets.includes("dom")
  );

  if (
    !context.masksAllText &&
    !context.masksFieldValues &&
    !context.heuristics &&
    !(context.redacts && hasDomPatterns)
  ) {
    return null;
  }

  return (text, element) => {
    if (element?.localName === "style") {
      return context.heuristics ? sanitizeCss(text) : text;
    }

    if (context.masksAllText || (context.masksFieldValues && isFieldText(element))) {
      return maskAll(text);
    }

    return context.heuristics
      ? sanitizeRawDomText(text, policy.redaction, context.extraNameParts)
      : maskDomText(text, policy.redaction);
  };
}

function isHiddenInput(tagName: string, readAttribute: (name: string) => string | null): boolean {
  // HTML does not trim `type`, but a `"hidden "` field still holds form state.
  return tagName === "input" && (readAttribute("type") ?? "").trim().toLowerCase() === "hidden";
}

function maskStyleValue(value: unknown, context: MaskContext): unknown {
  // A mutation records `style` changes as `{ property: value | [value, priority] | false }`.
  if (!context.heuristics || value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([property, change]) => [
      property,
      typeof change === "string"
        ? sanitizeCss(change)
        : Array.isArray(change)
          ? change.map((part) => (typeof part === "string" ? sanitizeCss(part) : part))
          : change
    ])
  );
}

function maskAttributeValue(name: string, value: string, context: MaskContext): string {
  if (name === "_csstext") {
    return context.heuristics ? sanitizeCss(value) : value;
  }

  if (context.masksAllText && TEXT_ATTRIBUTES.has(name)) {
    return maskAll(value);
  }

  if (!context.redacts) {
    return value;
  }

  return context.heuristics
    ? sanitizeRawDomAttribute(name, value, context.policy.redaction, context.extraNameParts)
    : maskDomText(value, context.policy.redaction);
}

/**
 * Attribute values of one element as recorded. `readAttribute` reads the element's other
 * attributes (from the record, or the live element for a mutation that carries only changes).
 */
function maskAttributes(
  tagName: string,
  attributes: Attributes,
  readAttribute: (name: string) => string | null,
  context: MaskContext
): Attributes {
  const tag = tagName.toLowerCase();

  return Object.fromEntries(
    Object.entries(attributes).flatMap(([name, value]): Array<[string, unknown]> => {
      const key = name.toLowerCase();

      if (typeof value !== "string") {
        return [[name, key === "style" ? maskStyleValue(value, context) : value]];
      }

      if (context.heuristics && isDroppedRawDomAttribute(tag, key, readAttribute)) {
        return [];
      }

      if (
        key === "value" &&
        (isHiddenInput(tag, readAttribute) ||
          (context.masksFieldValues && VALUE_ATTRIBUTE_TAGS.has(tag)))
      ) {
        return [];
      }

      // rrweb masks a field's live value only when it is not empty and the field is typed text:
      // a cleared field keeps its default `value`, radios, checkboxes and buttons keep theirs.
      // Masking is idempotent on what rrweb already masked.
      if (key === "value" && context.masksFieldValues && (tag === "input" || tag === "textarea")) {
        return [[name, maskAll(value)]];
      }

      return [[name, maskAttributeValue(key, value, context)]];
    })
  );
}

function readFrom(attributes: Attributes): (name: string) => string | null {
  return (name) => {
    const value = attributes[name];
    return typeof value === "string" ? value : null;
  };
}

/** A serialized node (`serializedNodeWithId`) and its subtree as recorded. */
function maskNode(node: unknown, parentTag: string, context: MaskContext): unknown {
  const record = asRecord(node);

  if (!record) {
    return node;
  }

  if (
    record.type === TEXT_NODE &&
    parentTag === "style" &&
    typeof record.textContent === "string"
  ) {
    return context.heuristics
      ? { ...record, textContent: sanitizeCss(record.textContent) }
      : record;
  }

  if (record.type !== ELEMENT_NODE || typeof record.tagName !== "string") {
    return Array.isArray(record.childNodes)
      ? { ...record, childNodes: record.childNodes.map((child) => maskNode(child, "", context)) }
      : record;
  }

  const tagName = record.tagName.toLowerCase();
  const attributes = asRecord(record.attributes);

  return {
    ...record,
    ...(attributes
      ? { attributes: maskAttributes(tagName, attributes, readFrom(attributes), context) }
      : {}),
    ...(Array.isArray(record.childNodes)
      ? { childNodes: record.childNodes.map((child) => maskNode(child, tagName, context)) }
      : {})
  };
}

function elementOf(lookup: RrwebNodeLookup, id: unknown): Element | null {
  const node = typeof id === "number" ? lookup(id) : null;
  return node !== null && node.nodeType === Node.ELEMENT_NODE ? (node as Element) : null;
}

function maskMutation(data: Attributes, lookup: RrwebNodeLookup, context: MaskContext): Attributes {
  const adds = Array.isArray(data.adds)
    ? data.adds.map((add) => {
        const record = asRecord(add);
        const parentTag = record ? (elementOf(lookup, record.parentId)?.localName ?? "") : "";
        return record ? { ...record, node: maskNode(record.node, parentTag, context) } : add;
      })
    : data.adds;
  const attributes = Array.isArray(data.attributes)
    ? data.attributes.map((change) => {
        const record = asRecord(change);
        const values = record ? asRecord(record.attributes) : null;
        const element = record ? elementOf(lookup, record.id) : null;

        if (!record || !values) {
          return change;
        }

        const readAttribute = (name: string): string | null =>
          readFrom(values)(name) ?? element?.getAttribute(name) ?? null;
        return {
          ...record,
          attributes: maskAttributes(element?.localName ?? "", values, readAttribute, context)
        };
      })
    : data.attributes;

  return { ...data, adds, attributes };
}

/**
 * Applies the policy's attribute, style and hidden-field rules to one rrweb event, page side,
 * before it leaves the page. `lookup` resolves node ids of mutations to live nodes.
 */
export function createRrwebEventMask(
  policy: CapturePolicy,
  lookup: RrwebNodeLookup
): (event: RrwebRecordedEvent) => RrwebRecordedEvent {
  const context = contextOf(policy);

  return (event) => {
    const data = asRecord(event.data);

    if (!data) {
      return event;
    }

    if (event.type === RRWEB_EVENT_TYPES.fullSnapshot) {
      return { ...event, data: { ...data, node: maskNode(data.node, "", context) } };
    }

    if (event.type !== RRWEB_EVENT_TYPES.incrementalSnapshot) {
      return event;
    }

    if (data.source === RRWEB_INCREMENTAL_SOURCES.mutation) {
      return { ...event, data: maskMutation(data, lookup, context) };
    }

    if (CSSOM_SOURCES.has(data.source as number)) {
      return context.heuristics ? { ...event, data: maskCssomChange(data) } : event;
    }

    const field = data.source === INPUT_SOURCE ? elementOf(lookup, data.id) : null;

    // rrweb's `maskAllInputs` leaves hidden fields out; their value is form state, never typed.
    return field && isHiddenInput(field.localName, (name) => field.getAttribute(name))
      ? { ...event, data: { ...data, text: "" } }
      : event;
  };
}

const CSSOM_SOURCES = new Set([
  STYLE_SHEET_RULE_SOURCE,
  STYLE_DECLARATION_SOURCE,
  ADOPTED_STYLE_SHEET_SOURCE
]);

const sanitizeCssField = (value: unknown): unknown =>
  typeof value === "string" ? sanitizeCss(value) : value;

function maskRules(rules: unknown): unknown {
  return Array.isArray(rules)
    ? rules.map((entry) => {
        const record = asRecord(entry);
        return record ? { ...record, rule: sanitizeCssField(record.rule) } : entry;
      })
    : rules;
}

/**
 * CSS written through the CSSOM (`insertRule`, `replace`, `style.setProperty`, adopted sheets),
 * under the built-in heuristics like the style text of the snapshot.
 */
function maskCssomChange(data: Attributes): Attributes {
  const set = asRecord(data.set);
  const styles = Array.isArray(data.styles)
    ? data.styles.map((style) => {
        const record = asRecord(style);
        return record ? { ...record, rules: maskRules(record.rules) } : style;
      })
    : data.styles;

  return {
    ...data,
    ...(data.adds !== undefined ? { adds: maskRules(data.adds) } : {}),
    ...(data.replace !== undefined ? { replace: sanitizeCssField(data.replace) } : {}),
    ...(data.replaceSync !== undefined ? { replaceSync: sanitizeCssField(data.replaceSync) } : {}),
    ...(set ? { set: { ...set, value: sanitizeCssField(set.value) } } : {}),
    ...(styles !== undefined ? { styles } : {})
  };
}

function asRecord(value: unknown): Attributes | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Attributes)
    : null;
}
