import { extractRequestId, type WebBlackboxEvent } from "@webblackbox/protocol";
import { isProblemRequest, type ActionConsequenceRequest } from "@webblackbox/player-sdk";

import type { ArchiveModel } from "./archive-model.js";

/**
 * Every request of an action, from its own events (`ref.act`): deduplicated, in start order, with
 * the waterfall's error text. The action timeline keeps only the first few requests, so the feed
 * row ("6 requests · 5 failed") and the inspector both count from this list.
 */
export function collectActionRequests(
  model: Pick<ArchiveModel, "waterfallByReqId">,
  events: readonly WebBlackboxEvent[]
): ActionConsequenceRequest[] {
  const seen = new Set<string>();
  const requests: ActionConsequenceRequest[] = [];

  for (const event of events) {
    const reqId = extractRequestId(event);
    const entry = reqId && !seen.has(reqId) ? model.waterfallByReqId.get(reqId) : undefined;

    if (!reqId || !entry) {
      continue;
    }

    seen.add(reqId);
    requests.push({
      reqId,
      method: entry.method,
      url: entry.url,
      status: entry.status ?? null,
      failed: entry.failed,
      ...(entry.errorText ? { errorText: entry.errorText } : {}),
      startMono: entry.startMono,
      eventIds: entry.eventIds
    });
  }

  return requests.sort((left, right) => left.startMono - right.startMono);
}

/** The problems strip's rule (an HTTP error or a failure that is not a cancellation). */
function isFailedRequest(request: ActionConsequenceRequest): boolean {
  return isProblemRequest({
    ...request,
    status: request.status ?? undefined,
    eventIds: request.eventIds ?? []
  });
}

export type ActionRequestCounts = { requests: number; failed: number };

/**
 * Request and failure counts per action id, built in one pass over the archive. Failures follow
 * the problems strip: an HTTP error or a network failure, not a cancellation (`ERR_ABORTED`).
 */
export function countActionRequests(
  model: Pick<ArchiveModel, "events" | "waterfallByReqId">
): Map<string, ActionRequestCounts> {
  const eventsByAct = new Map<string, WebBlackboxEvent[]>();

  for (const event of model.events) {
    const actId = event.ref?.act;

    if (!actId) {
      continue;
    }

    // A local index being built: appending keeps the pass linear on 50k-event archives.
    const list = eventsByAct.get(actId);

    if (list) {
      list.push(event);
    } else {
      eventsByAct.set(actId, [event]);
    }
  }

  return new Map(
    [...eventsByAct].map(([actId, events]) => {
      const requests = collectActionRequests(model, events);
      return [
        actId,
        { requests: requests.length, failed: requests.filter(isFailedRequest).length }
      ];
    })
  );
}
