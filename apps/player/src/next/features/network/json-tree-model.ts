/**
 * A JSON value flattened to the rows a virtualized tree shows: only expanded containers contribute
 * their children, so a multi-megabyte body with a few open nodes stays a few hundred rows.
 */

export type JsonValueKind = "object" | "array" | "string" | "number" | "boolean" | "null";

export type JsonTreeRow = {
  /** `$`, `$.user.name`, `$.items[3]`, `$["odd key"]`: stable id, expansion key and "Copy path". */
  path: string;
  depth: number;
  /** Property name or array index; `null` for the root. */
  key: string | number | null;
  kind: JsonValueKind;
  value: unknown;
  /** Children of a container (keys or items). */
  childCount: number;
  expanded: boolean;
};

/** Containers deeper than this open only on demand. */
export const DEFAULT_EXPAND_DEPTH = 2;
/** A big container is not opened by default even within the default depth. */
const DEFAULT_EXPAND_MAX_CHILDREN = 50;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export function kindOf(value: unknown): JsonValueKind {
  if (value === null || value === undefined) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  const type = typeof value;

  if (type === "object") {
    return "object";
  }

  return type === "string" || type === "number" || type === "boolean" ? type : "null";
}

export function childPath(parent: string, key: string | number): string {
  if (typeof key === "number") {
    return `${parent}[${key}]`;
  }

  return IDENTIFIER.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function entriesOf(value: unknown): Array<[string | number, unknown]> {
  if (Array.isArray(value)) {
    return value.map((item, index) => [index, item]);
  }

  return kindOf(value) === "object" ? Object.entries(value as Record<string, unknown>) : [];
}

/** Rows of `value` with the containers in `expanded` open. */
export function flattenJson(value: unknown, expanded: ReadonlySet<string>): JsonTreeRow[] {
  const rows: JsonTreeRow[] = [];
  const visit = (node: unknown, path: string, depth: number, key: string | number | null) => {
    const kind = kindOf(node);
    const children = kind === "object" || kind === "array" ? entriesOf(node) : [];
    const isOpen = children.length > 0 && expanded.has(path);

    rows.push({
      path,
      depth,
      key,
      kind,
      value: node,
      childCount: children.length,
      expanded: isOpen
    });

    if (isOpen) {
      for (const [childKey, child] of children) {
        visit(child, childPath(path, childKey), depth + 1, childKey);
      }
    }
  };

  visit(value, "$", 0, null);
  return rows;
}

/** The paths opened by default: the first levels, skipping very large containers. */
export function defaultExpandedPaths(
  value: unknown,
  depth: number = DEFAULT_EXPAND_DEPTH
): Set<string> {
  const paths = new Set<string>();
  const visit = (node: unknown, path: string, level: number) => {
    const children = entriesOf(node);

    if (children.length === 0 || level >= depth) {
      return;
    }

    if (level > 0 && children.length > DEFAULT_EXPAND_MAX_CHILDREN) {
      return;
    }

    paths.add(path);

    for (const [key, child] of children) {
      visit(child, childPath(path, key), level + 1);
    }
  };

  visit(value, "$", 0);
  return paths;
}

/** Container paths breadth-first, up to `limit`: "Expand all" without freezing on huge bodies. */
export function allContainerPaths(value: unknown, limit: number): Set<string> {
  const paths = new Set<string>();
  const queue: Array<[unknown, string]> = [[value, "$"]];

  for (let head = 0; head < queue.length && paths.size < limit; head += 1) {
    const [node, path] = queue[head] as [unknown, string];
    const children = entriesOf(node);

    if (children.length === 0) {
      continue;
    }

    paths.add(path);

    for (const [key, child] of children) {
      queue.push([child, childPath(path, key)]);
    }
  }

  return paths;
}

/** One-line text of a scalar (strings JSON-quoted). */
export function scalarText(row: Pick<JsonTreeRow, "kind" | "value">): string {
  return row.kind === "string" ? JSON.stringify(row.value) : String(row.value ?? "null");
}
