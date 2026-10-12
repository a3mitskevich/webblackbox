/**
 * The parts of rrweb's recorded format (`rrweb-snapshot` serialized nodes, incremental mutation
 * data) that the headless DOM reads. Archive data is untrusted: every field is checked where it is
 * read, and anything malformed is skipped rather than trusted.
 */

/** rrweb-snapshot `NodeType`. */
export const SERIALIZED_NODE_TYPES = {
  document: 0,
  documentType: 1,
  element: 2,
  text: 3,
  cdata: 4,
  comment: 5
} as const;

export type SerializedNode = {
  type: number;
  id: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  childNodes?: unknown[];
  textContent?: string;
  name?: string;
  isShadow?: boolean;
  isShadowHost?: boolean;
};

export type MutationAdd = {
  parentId: number;
  nextId: number | null;
  previousId: number | null;
  node: SerializedNode;
};

export type MutationRemove = { parentId: number; id: number };
export type MutationText = { id: number; value: string | null };
export type MutationAttributes = { id: number; attributes: Record<string, unknown> };

export type MutationData = {
  adds: MutationAdd[];
  removes: MutationRemove[];
  texts: MutationText[];
  attributes: MutationAttributes[];
};

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isNodeId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** A serialized node with a valid type and id, or null. Children are checked as they are read. */
export function asSerializedNode(value: unknown): SerializedNode | null {
  const record = asRecord(value);

  if (!record || typeof record.type !== "number" || !isNodeId(record.id)) {
    return null;
  }

  return record as SerializedNode;
}

function optionalNodeId(value: unknown): number | null {
  return isNodeId(value) ? value : null;
}

function listOf<T>(value: unknown, read: (entry: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const parsed = record ? read(record) : null;
    return parsed === null ? [] : [parsed];
  });
}

/** The mutation data of an rrweb `IncrementalSource.Mutation` event, malformed entries dropped. */
export function readMutationData(data: unknown): MutationData {
  const record = asRecord(data) ?? {};

  return {
    adds: listOf(record.adds, (entry) => {
      const node = asSerializedNode(entry.node);
      return node && isNodeId(entry.parentId)
        ? {
            parentId: entry.parentId,
            nextId: optionalNodeId(entry.nextId),
            previousId: optionalNodeId(entry.previousId),
            node
          }
        : null;
    }),
    removes: listOf(record.removes, (entry) =>
      isNodeId(entry.parentId) && isNodeId(entry.id)
        ? { parentId: entry.parentId, id: entry.id }
        : null
    ),
    texts: listOf(record.texts, (entry) =>
      isNodeId(entry.id)
        ? { id: entry.id, value: typeof entry.value === "string" ? entry.value : null }
        : null
    ),
    attributes: listOf(record.attributes, (entry) => {
      const attributes = asRecord(entry.attributes);
      return isNodeId(entry.id) && attributes ? { id: entry.id, attributes } : null;
    })
  };
}
