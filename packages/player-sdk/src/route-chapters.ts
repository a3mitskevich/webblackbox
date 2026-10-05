import type { WebBlackboxEvent } from "@webblackbox/protocol";

/**
 * How a chapter started: `load` is the page before the first recorded navigation, `document` a
 * full navigation, `reload` a page reload and `route` a same-document (hash or History API) change.
 */
export type RouteChapterKind = "load" | "document" | "reload" | "route";

/** One stretch of the session spent on one page or client-side route. */
export type RouteChapter = {
  kind: RouteChapterKind;
  /** Short label: the hash route (`#/lobby`) for hash routers, otherwise the path (`/cart`). */
  label: string;
  /** Full URL when the archive recorded it. */
  url?: string;
  /** Navigation event that started the chapter; absent for the `load` chapter. */
  eventId?: string;
  startMono: number;
  endMono: number;
};

export type RouteChapterOptions = {
  /** End of the last chapter; defaults to the last event. */
  endMono?: number;
  /** URL of the page before the first navigation when no event names it (e.g. the site origin). */
  initialUrl?: string;
};

type NavigationPoint = {
  kind: Exclude<RouteChapterKind, "load">;
  url: string;
  eventId: string;
  mono: number;
};

const ROUTE_NAVIGATION_TYPES = new Set(["nav.hash", "nav.history.push", "nav.history.replace"]);

/**
 * Route chapters of the top-level page, from `nav.*` events in mono order. Iframe navigations are
 * ignored; repeated navigations to the same label extend the current chapter, and a document load of
 * the open page (same origin and path) counts as a reload. Archive data is untrusted: events without a readable URL are
 * skipped.
 */
export function buildRouteChapters(
  events: readonly WebBlackboxEvent[],
  options: RouteChapterOptions = {}
): RouteChapter[] {
  const first = events[0];

  if (!first) {
    return [];
  }

  const endMono = options.endMono ?? events[events.length - 1]?.mono ?? first.mono;
  const points = readNavigationPoints(events);
  const chapters: RouteChapter[] = [];
  const firstPoint = points[0];
  const initialUrl = readInitialUrl(events, firstPoint?.mono) ?? options.initialUrl;

  if (initialUrl && (!firstPoint || firstPoint.mono > first.mono)) {
    chapters.push({
      kind: "load",
      label: formatRouteLabel(initialUrl),
      url: initialUrl,
      startMono: first.mono,
      endMono: firstPoint?.mono ?? endMono
    });
  }

  for (const point of points) {
    const label = formatRouteLabel(point.url);
    const previous = chapters[chapters.length - 1];

    if (previous && point.kind === "route" && previous.label === label) {
      continue;
    }

    // Loading the document that is already open is a reload (e.g. "Try again" on an error page).
    const kind =
      point.kind === "document" && previous?.url && isSameDocument(previous.url, point.url)
        ? "reload"
        : point.kind;

    if (previous) {
      chapters[chapters.length - 1] = { ...previous, endMono: point.mono };
    }

    chapters.push({
      kind,
      label,
      url: point.url,
      eventId: point.eventId,
      startMono: point.mono,
      endMono
    });
  }

  return chapters;
}

/** `#/lobby` for hash routes, else the path (`/`, `/cart`); unparsable input is returned trimmed. */
export function formatRouteLabel(url: string): string {
  try {
    const parsed = new URL(url);

    return parsed.hash.length > 1 ? parsed.hash : parsed.pathname || "/";
  } catch {
    return url.trim();
  }
}

/** Same origin and path: query and hash changes do not make a different page. */
function isSameDocument(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return left === right;
  }
}

function readNavigationPoints(events: readonly WebBlackboxEvent[]): NavigationPoint[] {
  const points: NavigationPoint[] = [];
  const frames = readCommittedFrames(events);

  for (const event of events) {
    if (!event.type.startsWith("nav.")) {
      continue;
    }

    const data = asRecord(event.data);

    if (event.type === "nav.commit") {
      const frame = asRecord(data?.frame);

      // Iframe documents carry their parent; the timeline follows the top-level page.
      if (asString(frame?.parentId)) {
        continue;
      }

      const url = asString(frame?.url) ?? asString(data?.url);

      if (url) {
        const kind = /reload/i.test(asString(data?.type) ?? "") ? "reload" : "document";
        points.push({ kind, url, eventId: event.id, mono: event.mono });
      }

      continue;
    }

    if (!isTopLevelFrame(asString(data?.frameId), frames)) {
      continue;
    }

    const url = asString(data?.url);

    if (!url) {
      continue;
    }

    if (event.type === "nav.reload") {
      points.push({ kind: "reload", url, eventId: event.id, mono: event.mono });
    } else if (ROUTE_NAVIGATION_TYPES.has(event.type)) {
      points.push({ kind: "route", url, eventId: event.id, mono: event.mono });
    }
  }

  return points;
}

type CommittedFrames = { main: ReadonlySet<string>; child: ReadonlySet<string> };

/**
 * Frame ids of every recorded document commit. Read up front, so iframe route changes recorded
 * before the first top-level commit (a session started on an open page) are recognised too.
 */
function readCommittedFrames(events: readonly WebBlackboxEvent[]): CommittedFrames {
  const main = new Set<string>();
  const child = new Set<string>();

  for (const event of events) {
    if (event.type !== "nav.commit") {
      continue;
    }

    const frame = asRecord(asRecord(event.data)?.frame);
    const id = asString(frame?.id);

    if (id) {
      (asString(frame?.parentId) ? child : main).add(id);
    }
  }

  return { main, child };
}

/** Events without a frame id, or from a frame never seen committing, count as top-level. */
function isTopLevelFrame(frameId: string | undefined, frames: CommittedFrames): boolean {
  if (!frameId) {
    return true;
  }

  if (frames.child.has(frameId)) {
    return false;
  }

  return frames.main.size === 0 || frames.main.has(frameId);
}

/** The page URL before the first navigation: a session start URL or an early route context. */
function readInitialUrl(
  events: readonly WebBlackboxEvent[],
  beforeMono: number | undefined
): string | undefined {
  for (const event of events) {
    if (beforeMono !== undefined && event.mono >= beforeMono) {
      return undefined;
    }

    const data = asRecord(event.data);
    const url =
      event.type === "meta.session.start"
        ? asString(data?.url)
        : asString(asRecord(data?.routeContext)?.url);

    if (url) {
      return url;
    }
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
