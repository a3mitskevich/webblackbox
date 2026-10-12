import {
  A11Y_SNAPSHOT_LIMITS,
  validateEventData,
  type A11ySnapshotTriggerKind,
  type DomA11ySnapshotData,
  type WebBlackboxEvent
} from "@webblackbox/protocol";

import { compactText } from "./normalizer-utils.js";
import { recordedPageText, recordedUrl } from "./url-recording.js";

/** Raw type of the page-side accessibility snapshot. */
export const A11Y_SNAPSHOT_RAW_TYPE = "a11ySnapshot";
/** Recent trigger events remembered per kind, for linking. */
const RECENT_TRIGGERS_PER_KIND = 16;
/** How far a trigger event may lie from where the snapshot says it was (clock skew, rounding). */
const LINK_TOLERANCE_MS = 1_500;
const ACTION_EVENT_TYPES = new Set([
  "user.click",
  "user.dblclick",
  "user.submit",
  "user.contextmenu",
  "user.auxclick"
]);
const ACTION_KEYS = new Set(["Enter", "NumpadEnter"]);
const NAVIGATION_EVENT_TYPES = new Set([
  "nav.commit",
  "nav.history.push",
  "nav.history.replace",
  "nav.hash"
]);

/**
 * An accessibility snapshot from the page, checked against the strict protocol schema (malformed
 * payloads are dropped). The page already applied the profile's content rules; its URL, title and
 * text pass the session's URL and value-pattern rules once more, so a stale page script cannot
 * bypass them.
 */
export function normalizeA11ySnapshotPayload(payload: unknown): DomA11ySnapshotData | null {
  const parsed = validateEventData("dom.a11y.snapshot", payload);

  if (!parsed.success) {
    return null;
  }

  const snapshot = parsed.data as DomA11ySnapshotData;

  return {
    ...snapshot,
    url: compactText(recordedUrl(snapshot.url), A11Y_SNAPSHOT_LIMITS.maxUrlChars),
    ...(snapshot.title !== undefined
      ? { title: compactText(recordedPageText(snapshot.title), A11Y_SNAPSHOT_LIMITS.maxUrlChars) }
      : {}),
    tree: recordedPageText(snapshot.tree)
  };
}

type RecentTrigger = { id: string; mono: number };

/**
 * Links each accessibility snapshot to the recorded event that triggered it (`trigger.eventId`):
 * the event of the trigger's kind closest to `mono - trigger.delayMs`. Snapshots that already name
 * their event (Full mode errors reported by the debugger) are kept as they are.
 */
export class A11yTriggerLinker {
  private readonly recent = new Map<A11ySnapshotTriggerKind, RecentTrigger[]>();

  public link(event: WebBlackboxEvent): WebBlackboxEvent {
    const kind = triggerKindOf(event);

    if (kind) {
      this.remember(kind, event);
      return event;
    }

    if (event.type !== "dom.a11y.snapshot") {
      return event;
    }

    const data = event.data as DomA11ySnapshotData;

    if (data.trigger.eventId) {
      return event;
    }

    const eventId = this.find(data.trigger.kind, event.mono - (data.trigger.delayMs ?? 0));
    return eventId ? { ...event, data: { ...data, trigger: { ...data.trigger, eventId } } } : event;
  }

  private remember(kind: A11ySnapshotTriggerKind, event: WebBlackboxEvent): void {
    const list = this.recent.get(kind) ?? [];
    this.recent.set(kind, [
      ...list.slice(-(RECENT_TRIGGERS_PER_KIND - 1)),
      { id: event.id, mono: event.mono }
    ]);
  }

  private find(kind: A11ySnapshotTriggerKind, triggeredAt: number): string | undefined {
    let best: RecentTrigger | undefined;

    for (const candidate of this.recent.get(kind) ?? []) {
      const distance = Math.abs(candidate.mono - triggeredAt);

      if (
        distance <= LINK_TOLERANCE_MS &&
        (!best || distance < Math.abs(best.mono - triggeredAt))
      ) {
        best = candidate;
      }
    }

    return best?.id;
  }
}

function triggerKindOf(event: WebBlackboxEvent): A11ySnapshotTriggerKind | null {
  if (ACTION_EVENT_TYPES.has(event.type)) {
    return "action";
  }

  if (event.type === "user.keydown") {
    const key = readField(event.data, "key");
    return typeof key === "string" && ACTION_KEYS.has(key) ? "action" : null;
  }

  if (event.type === "error.exception" || event.type === "error.unhandledrejection") {
    return "error";
  }

  if (event.type === "console.entry") {
    return readField(event.data, "level") === "error" ? "error" : null;
  }

  if (NAVIGATION_EVENT_TYPES.has(event.type)) {
    return "navigation";
  }

  return event.type === "user.marker" ? "marker" : null;
}

function readField(data: unknown, key: string): unknown {
  return typeof data === "object" && data !== null
    ? (data as Record<string, unknown>)[key]
    : undefined;
}
