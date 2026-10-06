import type { WebBlackboxEvent } from "@webblackbox/protocol";
import type { ActionTimelineEntry } from "@webblackbox/player-sdk";

import {
  inferEventScope,
  matchesScopeFilter,
  type EventScope,
  type ScopeFilter
} from "../lib/scope.js";
import { isErrorEvent, type ArchiveModel } from "./archive-model.js";

/** Event-type filter of the event and action lists. */
export type TimelineFilter = "all" | "errors" | "network" | "storage" | "console";

/** Text, type and frame-scope filters shared by the event and action lists. */
export type TimelineFilterState = {
  text: string;
  type: TimelineFilter;
  scope: ScopeFilter;
};

/**
 * Events up to `visibleCount` (the playhead) that pass the filters. Text matches the precomputed
 * lower-case search text of each event.
 */
export function filterTimelineEvents(
  model: ArchiveModel,
  visibleCount: number,
  filters: TimelineFilterState
): WebBlackboxEvent[] {
  const text = filters.text.trim().toLowerCase();
  const filterType = filters.type;
  const scopeFilter = filters.scope;

  if (!text && filterType === "all" && scopeFilter === "all") {
    return model.events.slice(0, visibleCount);
  }

  const filtered: WebBlackboxEvent[] = [];

  for (let index = 0; index < visibleCount; index += 1) {
    const event = model.events[index];

    if (!event) {
      continue;
    }

    if (!matchesTypeFilter(event, filterType)) {
      continue;
    }

    if (!matchesScopeFilter(resolveEventScope(model, event), scopeFilter)) {
      continue;
    }

    if (text && !model.eventSearchText[index]?.includes(text)) {
      continue;
    }

    filtered.push(event);
  }

  return filtered;
}

export function filterActionEntries(
  model: ArchiveModel,
  visibleCount: number,
  filters: TimelineFilterState
): ActionTimelineEntry[] {
  const text = filters.text.trim().toLowerCase();
  const filterType = filters.type;
  const scopeFilter = filters.scope;

  if (!text && filterType === "all" && scopeFilter === "all") {
    return model.actionTimeline.slice(0, visibleCount);
  }

  const filtered: ActionTimelineEntry[] = [];

  for (let index = 0; index < visibleCount; index += 1) {
    const action = model.actionTimeline[index];

    if (!action) {
      continue;
    }

    if (!matchesActionTypeFilter(action, filterType)) {
      continue;
    }

    if (!matchesScopeFilter(resolveActionScope(model, action), scopeFilter)) {
      continue;
    }

    if (text && !model.actionSearchText[index]?.includes(text)) {
      continue;
    }

    filtered.push(action);
  }

  return filtered;
}

export function matchesTypeFilter(event: WebBlackboxEvent, filterType: TimelineFilter): boolean {
  if (filterType === "all") {
    return true;
  }

  if (filterType === "errors") {
    return isErrorEvent(event);
  }

  if (filterType === "network") {
    return event.type.startsWith("network.");
  }

  if (filterType === "storage") {
    return event.type.startsWith("storage.");
  }

  if (filterType === "console") {
    return event.type.startsWith("console.") || isErrorEvent(event);
  }

  return true;
}

export function matchesActionTypeFilter(
  action: ActionTimelineEntry,
  filterType: TimelineFilter
): boolean {
  if (filterType === "all") {
    return true;
  }

  if (filterType === "errors") {
    return action.errorCount > 0;
  }

  if (filterType === "network") {
    return action.requestCount > 0;
  }

  if (filterType === "storage") {
    return action.triggerType?.startsWith("storage.") ?? false;
  }

  if (filterType === "console") {
    return action.errorCount > 0 || (action.triggerType?.startsWith("console.") ?? false);
  }

  return true;
}

export function resolveEventScope(model: ArchiveModel, event: WebBlackboxEvent): EventScope {
  return model.eventScopeById.get(event.id) ?? inferEventScope(event);
}

export function resolveRequestScope(model: ArchiveModel, reqId: string): EventScope {
  return model.requestScopeByReqId.get(reqId) ?? "main";
}

export function resolveScopeByEventId(model: ArchiveModel, eventId: string): EventScope {
  const event = model.eventById.get(eventId);

  if (!event) {
    return "main";
  }

  return resolveEventScope(model, event);
}

export function resolveActionScope(model: ArchiveModel, action: ActionTimelineEntry): EventScope {
  const indexedScope = model.actionScopeByActId.get(action.actId);

  if (indexedScope) {
    return indexedScope;
  }

  const triggerEvent = model.eventById.get(action.triggerEventId);

  if (triggerEvent && resolveEventScope(model, triggerEvent) === "iframe") {
    return "iframe";
  }

  const hasIframeRequest = action.requests.some(
    (request) => resolveRequestScope(model, request.reqId) === "iframe"
  );

  if (hasIframeRequest) {
    return "iframe";
  }

  const hasIframeError = action.errors.some((error) => {
    const event = model.eventById.get(error.eventId);
    return Boolean(event && resolveEventScope(model, event) === "iframe");
  });

  if (hasIframeError) {
    return "iframe";
  }

  return "main";
}
