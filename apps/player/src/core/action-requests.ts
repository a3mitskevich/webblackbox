import { extractRequestId, type WebBlackboxEvent } from "@webblackbox/protocol";
import { isProblemRequest, type ActionConsequenceRequest } from "@webblackbox/player-sdk";

import type { ArchiveModel } from "./archive-model.js";

/** An action span's members, as `WebBlackboxPlayer.buildDerived()` reports them. */
export type ActionSpanMembers = { actId: string; eventIds: readonly string[] };

/** What an action is made of: its events and every request among them. */
export type ActionContents = {
  events: WebBlackboxEvent[];
  requests: ActionConsequenceRequest[];
};

export type ActionRequestCounts = { requests: number; failed: number };

type ActionArchive = {
  player: { buildDerived(): { actionSpans: readonly ActionSpanMembers[] } };
  model: Pick<ArchiveModel, "eventById" | "waterfallByReqId">;
};

const contentsCache = new WeakMap<ActionArchive, ReadonlyMap<string, ActionContents>>();

/**
 * Every request an action started, from its own events: deduplicated, in start order, with the
 * waterfall's error text. The action timeline keeps only the first few requests, so the feed row
 * ("6 requests · 5 failed") and the inspector both count from this list.
 *
 * An action owns a request when it holds the request's `network.request` event. A late response
 * of an earlier request carries the newer action's `ref.act`; it does not make the newer action
 * its cause. A request recorded without a request event belongs to the action it started in.
 */
export function collectActionRequests(
  model: Pick<ArchiveModel, "eventById" | "waterfallByReqId">,
  events: readonly WebBlackboxEvent[]
): ActionConsequenceRequest[] {
  // No spread: an action can hold tens of thousands of events.
  const startMono = events.reduce(
    (earliest, event) => Math.min(earliest, event.mono),
    Number.POSITIVE_INFINITY
  );
  const seen = new Set<string>();
  const requests: ActionConsequenceRequest[] = [];

  for (const event of events) {
    const reqId = extractRequestId(event);
    const entry = reqId && !seen.has(reqId) ? model.waterfallByReqId.get(reqId) : undefined;

    if (!reqId || !entry || !isStartedBy(model, entry, event, startMono)) {
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

function isStartedBy(
  model: Pick<ArchiveModel, "eventById">,
  entry: { startMono: number; eventIds: readonly string[] },
  event: WebBlackboxEvent,
  actionStartMono: number
): boolean {
  if (event.type === "network.request") {
    return true;
  }

  const hasRequestEvent = entry.eventIds.some(
    (id) => model.eventById.get(id)?.type === "network.request"
  );
  return !hasRequestEvent && entry.startMono >= actionStartMono;
}

/**
 * Events and requests of every action, explicit (`ref.act`) and inferred by the SDK
 * (`derived:<trigger>`: a trigger without `ref.act` and what followed it), built once per archive.
 */
export function actionContentsOf(archive: ActionArchive): ReadonlyMap<string, ActionContents> {
  const cached = contentsCache.get(archive);

  if (cached) {
    return cached;
  }

  const { model } = archive;
  const contents = new Map(
    archive.player.buildDerived().actionSpans.map((span) => {
      const events = span.eventIds.flatMap((id) => {
        const event = model.eventById.get(id);
        return event ? [event] : [];
      });
      return [span.actId, { events, requests: collectActionRequests(model, events) }] as const;
    })
  );
  contentsCache.set(archive, contents);
  return contents;
}

/** The problems strip's rule: an HTTP error, or a failure that is not a cancellation. */
function isFailedRequest(request: ActionConsequenceRequest): boolean {
  return isProblemRequest({
    ...request,
    status: request.status ?? undefined,
    eventIds: request.eventIds ?? []
  });
}

export function countActionRequests(
  requests: readonly ActionConsequenceRequest[]
): ActionRequestCounts {
  return { requests: requests.length, failed: requests.filter(isFailedRequest).length };
}
