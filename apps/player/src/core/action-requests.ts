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
 * Every request of an action, from its own events: deduplicated, in start order, with the
 * waterfall's error text. The action timeline keeps only the first few requests, so the feed row
 * ("6 requests · 5 failed") and the inspector both count from this list.
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
