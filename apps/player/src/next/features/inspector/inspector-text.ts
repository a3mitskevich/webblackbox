import type { EventPhraseVerb } from "@webblackbox/player-sdk";
import { extractRequestId, type WebBlackboxEvent } from "@webblackbox/protocol";

import type { PlayerI18n, PlayerLocale } from "../../../lib/i18n.js";
import { readEventSummaryText } from "../../../lib/signal-text.js";
import type { LoadedArchive } from "../../state.js";
import { describeFeedEvent } from "../feed/feed-view.js";
import type { Inspection } from "./inspector-model.js";
import type { InspectorMessageKey, InspectorTranslate } from "./messages.js";

const VERB_KEYS: Record<EventPhraseVerb, InspectorMessageKey> = {
  click: "verbClick",
  "double-click": "verbDoubleClick",
  "right-click": "verbRightClick",
  "middle-click": "verbMiddleClick",
  type: "verbType",
  submit: "verbSubmit",
  key: "verbKey",
  marker: "verbMarker",
  drag: "verbDrag",
  scroll: "verbScroll",
  "page-load": "verbPageLoad",
  reload: "verbReload",
  route: "verbRoute",
  request: "verbRequest",
  websocket: "verbWebSocket",
  console: "verbConsole",
  exception: "verbException",
  storage: "verbStorage",
  screenshot: "verbScreenshot",
  other: "verbOther"
};

/** User actions name their target and the route they happened on. */
const TARGET_VERBS = new Set<EventPhraseVerb>([
  "click",
  "double-click",
  "right-click",
  "middle-click",
  "type",
  "submit",
  "key",
  "drag"
]);
/** Messages are quoted; URLs and routes are not. */
const QUOTED_DETAIL_VERBS = new Set<EventPhraseVerb>(["console", "exception", "marker", "storage"]);
const PATH_TAIL_MAX = 48;

/** `https://h/gw/bff/users/api/v1.0/casino-user?x` → `…/users/api/v1.0/casino-user`. */
export function shortPath(url: string, max = PATH_TAIL_MAX): string {
  let path = url;

  try {
    const parsed = new URL(url);
    path = `${parsed.pathname}${parsed.hash.startsWith("#/") ? parsed.hash : ""}`;
  } catch {
    path = url.split("?")[0] ?? url;
  }

  if (path.length <= max) {
    return path;
  }

  // Cut at a segment boundary when there is one: `…/api/v1.0/casino-user`, not `…rs/api/…`.
  const tail = path.slice(path.length - max + 1);
  const slash = tail.indexOf("/");
  return `…${slash > 0 ? tail.slice(slash) : tail}`;
}

/**
 * The one-line summary (casefile C): "The user clicked “Live table 64” on #/lobby." and, for an
 * action, what came of it: "7 of 195 requests failed; the first, 401 GET …/casino-user, came
 * 0.12 s later."
 */
export function describeInspection(
  inspection: Inspection,
  t: InspectorTranslate,
  i18n: PlayerI18n
): { sentence: string; outcome: string } {
  const { phrase, target, reaction } = inspection;
  const quote = (text: string): string => t("quoted", { text });
  const targetText = phrase.target
    ? phrase.target === target?.text
      ? quote(phrase.target)
      : `<${phrase.target}>`
    : t("anElement");
  const detail = phrase.detail
    ? QUOTED_DETAIL_VERBS.has(phrase.verb)
      ? quote(phrase.detail)
      : phrase.detail
    : "";
  const lead = t(VERB_KEYS[phrase.verb], { target: targetText, key: detail, detail }).trim();
  const route =
    TARGET_VERBS.has(phrase.verb) && phrase.route ? t("onRoute", { route: phrase.route }) : "";
  const sentence = `${lead}${route}${t("sentenceEnd")}`;

  return { sentence, outcome: describeOutcome(inspection, t, i18n, reaction) };
}

function describeOutcome(
  { consequences }: Inspection,
  t: InspectorTranslate,
  i18n: PlayerI18n,
  reaction: Inspection["reaction"]
): string {
  if (consequences) {
    const first = consequences.firstFailure;

    if (consequences.failedRequests > 0 && first?.kind === "request") {
      return t("outcomeFailed", {
        failed: i18n.formatNumber(consequences.failedRequests),
        requests: i18n.formatNumber(consequences.requests),
        first: [first.status ?? "", first.method ?? "", shortPath(first.label)]
          .filter(Boolean)
          .join(" "),
        after: i18n.formatSeconds(first.offsetMs)
      });
    }

    const errors = consequences.consoleErrors + consequences.exceptions;

    if (errors > 0) {
      return t("outcomeErrors", { count: i18n.formatNumber(errors) });
    }

    if (consequences.requests > 0) {
      return t("outcomeOk", { requests: i18n.formatNumber(consequences.requests) });
    }
  }

  return reaction && !reaction.mutated ? t("outcomeNoReaction") : "";
}

/**
 * A one-line title for any event: the Activity feed's wording when the feed has the event, the
 * request (`401 GET …/casino-user`) for network events, else the type and a summary.
 */
export function eventTitle(
  archive: LoadedArchive,
  event: WebBlackboxEvent,
  locale: PlayerLocale
): string {
  const row = describeFeedEvent(archive, event.id, locale);

  if (row) {
    return [row.code, row.lead, row.subject].filter(Boolean).join(" ");
  }

  const reqId = extractRequestId(event);
  const entry = reqId ? archive.model.waterfallByReqId.get(reqId) : undefined;

  if (entry) {
    return [entry.status ?? "", entry.method, shortPath(entry.url)].filter(Boolean).join(" ");
  }

  return `${event.type} ${readEventSummaryText(event)}`.trim();
}
