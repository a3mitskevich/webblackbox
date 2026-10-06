import type { WebBlackboxEvent } from "@webblackbox/protocol";

import type { WebBlackboxPlayer } from "./index.js";
import type { DomDiffResult, DomDiffTimelineOptions, DomSnapshotRef } from "./types.js";
import { asNumber, asRecord, asString } from "./value-readers.js";

/** Where `loadDomPaths` reads snapshot bodies and events from. */
export type DomPathSource = {
  getBlob: (hash: string) => Promise<{ mime: string; bytes: Uint8Array } | null>;
  findEventById: (eventId: string) => WebBlackboxEvent | null;
};

export function toDomSnapshotRefs(events: WebBlackboxEvent[]): DomSnapshotRef[] {
  return events
    .filter((event) => event.type === "dom.snapshot")
    .map((event) => {
      const payload = asRecord(event.data);

      return {
        eventId: event.id,
        mono: event.mono,
        t: event.t,
        snapshotId: asString(payload?.snapshotId),
        contentHash: asString(payload?.contentHash),
        source: asString(payload?.source),
        nodeCount: asNumber(payload?.nodeCount),
        reason: asString(payload?.reason)
      };
    })
    .sort((left, right) => left.mono - right.mono);
}

export async function buildDomDiffTimeline(
  player: Pick<WebBlackboxPlayer, "getDomSnapshots" | "compareDomSnapshots">,
  options: DomDiffTimelineOptions
): Promise<DomDiffResult[]> {
  const snapshots = player.getDomSnapshots(options.range);

  if (snapshots.length < 2) {
    return [];
  }

  const start = Math.max(1, snapshots.length - Math.max(1, options.limit ?? snapshots.length));
  const diffs: DomDiffResult[] = [];

  for (let index = start; index < snapshots.length; index += 1) {
    const previous = snapshots[index - 1];
    const current = snapshots[index];

    if (!previous || !current) {
      continue;
    }

    const diff = await player.compareDomSnapshots(previous.eventId, current.eventId);

    if (diff) {
      diffs.push(diff);
    }
  }

  return diffs;
}

export async function loadDomPaths(
  snapshot: DomSnapshotRef,
  source: DomPathSource
): Promise<Set<string>> {
  if (snapshot.contentHash) {
    const blob = await source.getBlob(snapshot.contentHash);

    if (blob) {
      const text = new TextDecoder().decode(blob.bytes);

      if (blob.mime === "application/json") {
        try {
          const parsed = JSON.parse(text) as unknown;
          const fromCdp = extractCdpDomPaths(parsed);

          if (fromCdp.size > 0) {
            return fromCdp;
          }
        } catch {
          return new Set();
        }
      }

      if (blob.mime === "text/html" || snapshot.source === "html") {
        return extractHtmlPaths(text);
      }
    }
  }

  const event = source.findEventById(snapshot.eventId);
  const payload = asRecord(event?.data);
  const htmlSnippet = asString(payload?.htmlSnippet);

  if (!htmlSnippet) {
    return new Set();
  }

  return extractHtmlPaths(htmlSnippet);
}

export function buildDomDiff(
  previous: DomSnapshotRef,
  current: DomSnapshotRef,
  previousPaths: Set<string>,
  currentPaths: Set<string>
): DomDiffResult {
  const addedPaths = [...currentPaths].filter((path) => !previousPaths.has(path)).sort();
  const removedPaths = [...previousPaths].filter((path) => !currentPaths.has(path)).sort();
  const changedPaths = deriveChangedPaths(addedPaths, removedPaths);

  return {
    previous,
    current,
    addedPaths,
    removedPaths,
    changedPaths,
    summary: {
      added: addedPaths.length,
      removed: removedPaths.length,
      changed: changedPaths.length
    }
  };
}

function deriveChangedPaths(addedPaths: string[], removedPaths: string[]): string[] {
  const removedParents = new Set(removedPaths.map((path) => parentPath(path)).filter(Boolean));

  return addedPaths
    .filter((path) => {
      const parent = parentPath(path);
      return Boolean(parent) && removedParents.has(parent);
    })
    .sort();
}

function parentPath(path: string): string | null {
  const index = path.lastIndexOf("/");

  if (index <= 0) {
    return null;
  }

  return path.slice(0, index);
}

function extractCdpDomPaths(snapshot: unknown): Set<string> {
  const root = asRecord(snapshot);
  const strings = Array.isArray(root?.strings) ? root.strings : [];
  const documents = Array.isArray(root?.documents) ? root.documents : [];
  const firstDocument = asRecord(documents[0]);
  const nodes = asRecord(firstDocument?.nodes);
  const parentIndex = Array.isArray(nodes?.parentIndex) ? nodes.parentIndex : [];
  const nodeName = Array.isArray(nodes?.nodeName) ? nodes.nodeName : [];

  if (parentIndex.length === 0 || nodeName.length === 0) {
    return new Set();
  }

  const names = nodeName.map((nameIndex) => {
    if (typeof nameIndex !== "number" || !Number.isInteger(nameIndex)) {
      return "UNKNOWN";
    }

    return normalizeNodeName(strings[nameIndex]);
  });

  const childrenByParent = new Map<number, number[]>();

  for (let index = 0; index < parentIndex.length; index += 1) {
    const parent = parentIndex[index];

    if (typeof parent !== "number" || parent < 0) {
      continue;
    }

    const children = childrenByParent.get(parent) ?? [];
    children.push(index);
    childrenByParent.set(parent, children);
  }

  const paths = new Set<string>();
  const roots = parentIndex
    .map((parent, index) => ({ parent, index }))
    .filter((item) => typeof item.parent !== "number" || item.parent < 0)
    .map((item) => item.index);

  const stack: Array<{ index: number; path: string }> = [];

  for (const rootIndex of roots) {
    const rootName = names[rootIndex] ?? "UNKNOWN";

    if (rootName === "#DOCUMENT") {
      const children = childrenByParent.get(rootIndex) ?? [];

      for (const child of children) {
        stack.push({
          index: child,
          path: `/${names[child] ?? "UNKNOWN"}[1]`
        });
      }
      continue;
    }

    stack.push({
      index: rootIndex,
      path: `/${rootName}[1]`
    });
  }

  while (stack.length > 0) {
    const current = stack.pop();

    if (!current) {
      continue;
    }

    paths.add(current.path);
    const children = childrenByParent.get(current.index) ?? [];
    const siblingCounts = new Map<string, number>();

    for (const childIndex of children) {
      const childName = names[childIndex] ?? "UNKNOWN";
      const nextCount = (siblingCounts.get(childName) ?? 0) + 1;
      siblingCounts.set(childName, nextCount);
      stack.push({
        index: childIndex,
        path: `${current.path}/${childName}[${nextCount}]`
      });
    }
  }

  return paths;
}

function extractHtmlPaths(htmlSnippet: string): Set<string> {
  const tokenRegex = /<\/?([a-zA-Z0-9:-]+)(?:\s[^>]*)?>/g;
  const stack: string[] = [];
  const siblingCounts: number[] = [];
  const paths = new Set<string>();
  let match = tokenRegex.exec(htmlSnippet);

  while (match) {
    const rawTag = match[0] ?? "";
    const tag = normalizeNodeName(match[1]);
    const isClosing = rawTag.startsWith("</");
    const isSelfClosing = rawTag.endsWith("/>");

    if (isClosing) {
      stack.pop();
      siblingCounts.pop();
      match = tokenRegex.exec(htmlSnippet);
      continue;
    }

    const parentIndex = siblingCounts.length - 1;
    const nextIndex = parentIndex >= 0 ? (siblingCounts[parentIndex] ?? 0) + 1 : 1;

    if (parentIndex >= 0) {
      siblingCounts[parentIndex] = nextIndex;
    }

    const path = `${stack.join("")}/${tag}[${nextIndex}]`;
    paths.add(path);

    if (!isSelfClosing) {
      stack.push(`/${tag}[${nextIndex}]`);
      siblingCounts.push(0);
    }

    match = tokenRegex.exec(htmlSnippet);
  }

  return paths;
}

function normalizeNodeName(value: unknown): string {
  const raw = asString(value)?.trim();

  if (!raw) {
    return "UNKNOWN";
  }

  if (raw.startsWith("#")) {
    return raw.toUpperCase();
  }

  return raw.toUpperCase();
}
