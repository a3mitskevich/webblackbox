// Accessibility snapshots (`dom.a11y.snapshot`): what the user saw and could do at a key moment,
// as compact text (roles, accessible names, states, visible text). The zod schema lives apart in
// `a11y-schemas.ts`: page code imports this module and must not pull zod into its bundles.

/** What made the page take the snapshot. */
export const A11Y_SNAPSHOT_TRIGGER_KINDS = [
  // A click, a form submit or Enter: the state the action left.
  "action",
  // An uncaught exception, an unhandled rejection or `console.error`.
  "error",
  // A new document or a route change, once the page settled.
  "navigation",
  // A manual marker.
  "marker",
  // The recording stopped: the last state of the page.
  "stop"
] as const;

export type A11ySnapshotTriggerKind = (typeof A11Y_SNAPSHOT_TRIGGER_KINDS)[number];

/** How names, text and values were recorded. */
export const A11Y_SNAPSHOT_MASKING_LEVELS = [
  // As captured (content masking off).
  "none",
  // Blocked selectors masked, field values only where the inputs policy allows them.
  "masked",
  // Roles and states only: no names, text or values (`dom: wireframe`).
  "wireframe"
] as const;

export type A11ySnapshotMasking = (typeof A11Y_SNAPSHOT_MASKING_LEVELS)[number];

/** Bounds of one snapshot and of how often snapshots are taken. */
export const A11Y_SNAPSHOT_LIMITS = {
  /** Longest tree text; the rest is cut with an explicit marker line. */
  maxTreeChars: 24_000,
  /** Most nodes written. */
  maxNodes: 800,
  /** Longest accessible name, value or text run of one node. */
  maxTextChars: 160,
  /** Deepest nesting written; deeper nodes are lifted to this depth. */
  maxDepth: 32,
  /** Page time one snapshot may take before the walk stops (the snapshot is marked cut). */
  maxWalkMs: 40,
  /** Snapshots per rolling minute; triggers beyond it are counted, not captured. */
  maxPerMinute: 30,
  /** Longest URL or title kept on a snapshot. */
  maxUrlChars: 2_048
} as const;

/** One node of the snapshot tree before it is written as text. */
export type A11yTreeNode = {
  role: string;
  name?: string;
  /** Inline text: a field value or the visible text of a node without children. */
  value?: string;
  /** `disabled`, `checked`, `checked=mixed`, `expanded=false`, `level=2`, `masked`… */
  states?: string[];
  children?: A11yTreeNode[];
};

export type A11ySnapshotTrigger = {
  kind: A11ySnapshotTriggerKind;
  /** The raw event that fired it (`click`, `submit`, `keydown`, `pageError`, `popstate`…). */
  rawType?: string;
  /** Id of the recorded event the snapshot answers (the click, the error, the navigation). */
  eventId?: string;
  /** Further triggers folded into this snapshot while it waited for the page to settle. */
  coalesced?: number;
  /** How long after the (first) trigger the snapshot was taken. */
  delayMs?: number;
};

export type A11ySnapshotViewport = {
  w: number;
  h: number;
  scrollX: number;
  scrollY: number;
};

/** Payload of `dom.a11y.snapshot`. */
export type DomA11ySnapshotData = {
  trigger: A11ySnapshotTrigger;
  url: string;
  title?: string;
  viewport: A11ySnapshotViewport;
  /** Only what intersects the viewport of the top document (and same-origin frames in it). */
  scope: "viewport";
  /** One node per line, `- role "name" [state]: "value"`, children indented by two spaces. */
  tree: string;
  /** Nodes written. */
  nodeCount: number;
  /** Nodes left out by the size or time budget (the tree ends with a `# cut:` line). */
  omittedNodes: number;
  truncated: boolean;
  masking: A11ySnapshotMasking;
  /** Same-origin frames whose content is inlined under their `iframe` node. */
  frames?: number;
  /** Triggers not captured since the previous snapshot because of the per-minute cap. */
  droppedTriggers?: number;
  /** Page time the snapshot took. */
  durationMs: number;
};

/** Prefix of meta lines in the tree text (the cut marker). */
export const A11Y_TREE_META_PREFIX = "# ";
const INDENT = "  ";

export type FormattedA11yTree = {
  tree: string;
  nodeCount: number;
  omittedNodes: number;
  truncated: boolean;
};

/**
 * Writes nodes as text within the budget: depth first, so a cut keeps the top of the page. A cut
 * (size, node count, or `omittedBefore` nodes the walk already skipped) ends the text with a
 * `# cut:` line saying how many nodes are missing.
 */
export function formatA11yTree(
  roots: readonly A11yTreeNode[],
  options: { maxChars?: number; maxNodes?: number; omittedBefore?: number; cutReason?: string } = {}
): FormattedA11yTree {
  const maxChars = options.maxChars ?? A11Y_SNAPSHOT_LIMITS.maxTreeChars;
  const maxNodes = options.maxNodes ?? A11Y_SNAPSHOT_LIMITS.maxNodes;
  const lines: string[] = [];
  let chars = 0;
  let written = 0;
  let omitted = options.omittedBefore ?? 0;
  let cutReason = omitted > 0 ? options.cutReason : undefined;
  const stack: Array<{ node: A11yTreeNode; depth: number }> = roots
    .map((node) => ({ node, depth: 0 }))
    .reverse();

  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    const line = INDENT.repeat(depth) + formatA11yNodeLine(node);

    if (written >= maxNodes || chars + line.length + 1 > maxChars) {
      omitted += 1 + countA11yNodes(node.children ?? []);
      cutReason ??= written >= maxNodes ? "node budget" : "size budget";
      continue;
    }

    lines.push(line);
    chars += line.length + 1;
    written += 1;

    const children = node.children ?? [];

    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: children[index]!, depth: depth + 1 });
    }
  }

  if (omitted > 0) {
    lines.push(`${A11Y_TREE_META_PREFIX}cut: ${omitted} more nodes (${cutReason ?? "budget"})`);
  }

  return {
    tree: lines.join("\n"),
    nodeCount: written,
    omittedNodes: omitted,
    truncated: omitted > 0
  };
}

/** `- button "Pay" [disabled]`, `- textbox "Email" [invalid]: "a@b"`, `- list:` (with children). */
export function formatA11yNodeLine(node: A11yTreeNode): string {
  let line = `- ${node.role}`;

  if (node.name) {
    line += ` ${JSON.stringify(node.name)}`;
  }

  for (const state of node.states ?? []) {
    line += ` [${state}]`;
  }

  if (node.value !== undefined && node.value !== "") {
    line += `: ${JSON.stringify(node.value)}`;
  } else if (node.children && node.children.length > 0) {
    line += ":";
  }

  return line;
}

export type ParsedA11yTreeLine = {
  depth: number;
  role: string;
  name?: string;
  value?: string;
  states: string[];
};

const NODE_LINE_PATTERN = /^( *)- ([^\s":[\]]+)(.*)$/;
const STATE_PATTERN = /^ \[([^\]]+)\]/;

/** Reads one node line back; null for meta lines and anything else. */
export function parseA11yTreeLine(line: string): ParsedA11yTreeLine | null {
  const match = NODE_LINE_PATTERN.exec(line);

  if (!match) {
    return null;
  }

  const depth = Math.floor(match[1]!.length / INDENT.length);
  const parsed: ParsedA11yTreeLine = { depth, role: match[2]!, states: [] };
  let rest = match[3]!;

  if (rest.startsWith(' "')) {
    const name = readJsonString(rest.slice(1));

    if (!name) {
      return null;
    }

    parsed.name = name.value;
    rest = rest.slice(1 + name.length);
  }

  let state = STATE_PATTERN.exec(rest);

  while (state) {
    parsed.states.push(state[1]!);
    rest = rest.slice(state[0].length);
    state = STATE_PATTERN.exec(rest);
  }

  if (rest.startsWith(': "')) {
    const value = readJsonString(rest.slice(2));

    if (value) {
      parsed.value = value.value;
    }
  }

  return parsed;
}

/** Every node line of a tree text, meta lines skipped. */
export function parseA11yTree(tree: string): ParsedA11yTreeLine[] {
  const nodes: ParsedA11yTreeLine[] = [];

  for (const line of tree.split("\n")) {
    const parsed = parseA11yTreeLine(line);

    if (parsed) {
      nodes.push(parsed);
    }
  }

  return nodes;
}

function countA11yNodes(nodes: readonly A11yTreeNode[]): number {
  let count = 0;
  const stack = [...nodes];

  while (stack.length > 0) {
    const node = stack.pop()!;
    count += 1;
    stack.push(...(node.children ?? []));
  }

  return count;
}

/** A JSON string literal at the start of `text`, with its length in characters. */
function readJsonString(text: string): { value: string; length: number } | null {
  if (!text.startsWith('"')) {
    return null;
  }

  for (let index = 1; index < text.length; index += 1) {
    const char = text[index];

    if (char === "\\") {
      index += 1;
      continue;
    }

    if (char === '"') {
      try {
        const value: unknown = JSON.parse(text.slice(0, index + 1));
        return typeof value === "string" ? { value, length: index + 1 } : null;
      } catch {
        return null;
      }
    }
  }

  return null;
}
