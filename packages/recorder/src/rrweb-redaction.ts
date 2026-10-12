import {
  RRWEB_EVENT_TYPES,
  RRWEB_INCREMENTAL_SOURCES,
  recordUrl,
  type RedactionRules,
  type RrwebEventBatchPayload,
  type RrwebRecordedEvent
} from "@webblackbox/protocol";

/**
 * Attributes whose value is a URL. The page masks text, inputs and blocked elements through
 * rrweb's own options; the recorder only records these URLs under the URL rules, as it does for
 * every other URL in the archive (network events use the same rules, so the Player can still
 * match a resource to its recorded response body).
 */
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "poster",
  "cite",
  "background",
  "data",
  "ping",
  "longdesc",
  "lowsrc",
  "manifest",
  "codebase",
  "itemid",
  "xlink:href"
]);
const SRCSET_ATTRIBUTES = new Set(["srcset", "imagesrcset"]);

type Attributes = Record<string, unknown>;

/**
 * An rrweb batch with URL attributes recorded under the URL rules. It replaces the generic key
 * walker for these payloads: that walker would rewrite every `href`/`src` key of the node tree
 * without knowing it is a node and mask whole strings (a stylesheet, a text node) that merely
 * contain a body pattern such as `otp` or `token`.
 */
export function redactRrwebEventBatch(
  payload: RrwebEventBatchPayload,
  rules: RedactionRules
): RrwebEventBatchPayload {
  return {
    ...payload,
    events: payload.events.map((event) => redactRrwebEvent(event, rules))
  };
}

function redactRrwebEvent(event: RrwebRecordedEvent, rules: RedactionRules): RrwebRecordedEvent {
  const data = asRecord(event.data);

  if (!data) {
    return event;
  }

  if (event.type === RRWEB_EVENT_TYPES.meta && typeof data.href === "string") {
    return { ...event, data: { ...data, href: recordUrl(data.href, rules) } };
  }

  if (event.type === RRWEB_EVENT_TYPES.fullSnapshot) {
    return { ...event, data: { ...data, node: redactNode(data.node, rules) } };
  }

  if (
    event.type === RRWEB_EVENT_TYPES.incrementalSnapshot &&
    data.source === RRWEB_INCREMENTAL_SOURCES.mutation
  ) {
    return { ...event, data: redactMutation(data, rules) };
  }

  return event;
}

function redactMutation(data: Attributes, rules: RedactionRules): Attributes {
  const adds = Array.isArray(data.adds)
    ? data.adds.map((add) => {
        const record = asRecord(add);
        return record ? { ...record, node: redactNode(record.node, rules) } : add;
      })
    : data.adds;
  const attributes = Array.isArray(data.attributes)
    ? data.attributes.map((change) => {
        const record = asRecord(change);
        const values = record ? asRecord(record.attributes) : null;
        return record && values
          ? { ...record, attributes: redactAttributes(values, rules) }
          : change;
      })
    : data.attributes;

  return { ...data, adds, attributes };
}

/** A serialized node (rrweb-snapshot `serializedNodeWithId`) with its subtree redacted. */
function redactNode(node: unknown, rules: RedactionRules): unknown {
  const record = asRecord(node);

  if (!record) {
    return node;
  }

  const attributes = asRecord(record.attributes);
  const childNodes = Array.isArray(record.childNodes)
    ? record.childNodes.map((child) => redactNode(child, rules))
    : record.childNodes;

  return {
    ...record,
    ...(attributes ? { attributes: redactAttributes(attributes, rules) } : {}),
    ...(childNodes !== undefined ? { childNodes } : {})
  };
}

function redactAttributes(attributes: Attributes, rules: RedactionRules): Attributes {
  return Object.fromEntries(
    Object.entries(attributes).map(([name, value]) => [
      name,
      redactAttributeValue(name.toLowerCase(), value, rules)
    ])
  );
}

function redactAttributeValue(name: string, value: unknown, rules: RedactionRules): unknown {
  if (typeof value !== "string" || value.startsWith("data:") || value.startsWith("blob:")) {
    return value;
  }

  if (URL_ATTRIBUTES.has(name)) {
    return recordUrl(value, rules);
  }

  if (SRCSET_ATTRIBUTES.has(name)) {
    return parseSrcset(value)
      .map(({ url, descriptor }) =>
        [recordUrl(url, rules), ...(descriptor ? [descriptor] : [])].join(" ")
      )
      .join(", ");
  }

  return value;
}

/**
 * The candidates of a `srcset`, split as HTML does: a URL runs to the next whitespace (commas
 * inside it, as in `w_100,h_100` image transforms, are part of it; trailing ones end the
 * candidate), its descriptors to the next comma.
 */
function parseSrcset(value: string): Array<{ url: string; descriptor: string }> {
  const candidates: Array<{ url: string; descriptor: string }> = [];
  let index = 0;

  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index]!)) {
      index += 1;
    }

    const start = index;

    while (index < value.length && !/\s/.test(value[index]!)) {
      index += 1;
    }

    const token = value.slice(start, index);

    if (!token) {
      break;
    }

    if (token.endsWith(",")) {
      candidates.push({ url: token.replace(/,+$/, ""), descriptor: "" });
      continue;
    }

    const descriptorStart = index;

    while (index < value.length && value[index] !== ",") {
      index += 1;
    }

    candidates.push({ url: token, descriptor: value.slice(descriptorStart, index).trim() });
  }

  return candidates;
}

function asRecord(value: unknown): Attributes | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Attributes)
    : null;
}
