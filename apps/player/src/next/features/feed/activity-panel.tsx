import { Toggle } from "@base-ui/react/toggle";
import { Toolbar } from "@base-ui/react/toolbar";
import { useMemo } from "react";

import "./feed.css";

import { Hint } from "../../components/hint.js";
import { Icon } from "../../components/icon.js";
import { ListDetailsSplit } from "../../components/split-layout.js";
import { toastManager } from "../../components/toasts.js";
import { useController, usePlayerState } from "../../context.js";
import { resolveSelectedEventId } from "../../controller.js";
import { useFeatureI18n } from "../messages.js";
import { useFeatureSlice, useFeatureSliceUpdate } from "../slice.js";
import { ActivityFeed } from "./activity-feed.js";
import { feedViewOf } from "./feed-view.js";
import { feedMessages } from "./messages.js";
import { feedSlice, type FeedSlice } from "./slice.js";

function DetailsPanel() {
  const controller = useController();
  const t = useFeatureI18n(feedMessages);
  const archive = usePlayerState((state) => state.archive);
  const selection = usePlayerState((state) => state.selection);

  if (!archive || !selection) {
    return null;
  }

  const payload =
    selection.kind === "event"
      ? archive.model.eventById.get(selection.id)
      : selection.kind === "request"
        ? archive.model.waterfallByReqId.get(selection.id)
        : archive.model.actionTimeline.find((action) => action.actId === selection.id);

  return (
    <section className="details" aria-label={t("eventDetails")} data-testid="details-panel">
      <header className="details-head">
        <h2>{t("eventDetails")}</h2>
        <button
          type="button"
          className="btn icon-only small"
          aria-label={t("closeDetails")}
          onClick={() => controller.close()}
        >
          <Icon name="close" />
        </button>
      </header>
      <pre className="code" data-testid="details-json">
        {payload ? JSON.stringify(payload, null, 2) : t("detailsEmpty")}
      </pre>
    </section>
  );
}

const selectSlice = (slice: FeedSlice): FeedSlice => slice;

/** "Errors only", "Hide third-party" and the "N hidden" chip (Base UI Toolbar + Toggle). */
function FeedFilters() {
  const t = useFeatureI18n(feedMessages);
  const archive = usePlayerState((state) => state.archive);
  const query = usePlayerState((state) => state.query);
  const locale = usePlayerState((state) => state.locale);
  const selectedEventId = usePlayerState((state) =>
    state.archive ? resolveSelectedEventId(state.archive, state.selection) : null
  );
  const slice = useFeatureSlice(feedSlice, selectSlice);
  const update = useFeatureSliceUpdate(feedSlice);
  const hidden = useMemo(
    () =>
      archive
        ? feedViewOf(archive, { ...slice, query, selectedEventId, locale }).hiddenThirdParty
        : 0,
    [archive, slice, query, selectedEventId, locale]
  );

  const showThirdParty = (): void => {
    update((current) => ({ ...current, hideThirdParty: false }));
    toastManager.add({
      title: t("thirdPartyShown"),
      description: t("thirdPartyShownBody", { count: hidden }),
      actionProps: {
        children: t("hideAgain"),
        onClick: () => update((current) => ({ ...current, hideThirdParty: true }))
      }
    });
  };

  return (
    <Toolbar.Root className="feed-filters" aria-label={t("feedFilters")}>
      <Toolbar.Button
        render={
          <Toggle
            className="fchip"
            pressed={slice.errorsOnly}
            onPressedChange={(errorsOnly) => update((current) => ({ ...current, errorsOnly }))}
            data-testid="feed-errors-only"
          />
        }
      >
        {t("errorsOnly")}
      </Toolbar.Button>
      <Toolbar.Button
        render={
          <Toggle
            className="fchip"
            pressed={slice.hideThirdParty}
            onPressedChange={(hideThirdParty) =>
              update((current) => ({ ...current, hideThirdParty }))
            }
            data-testid="feed-hide-third-party"
          />
        }
      >
        {t("hideThirdParty")}
      </Toolbar.Button>
      {slice.hideThirdParty && hidden > 0 ? (
        <Hint label={t("hiddenCountHint")}>
          <Toolbar.Button
            className="hidden-chip"
            onClick={showThirdParty}
            data-testid="feed-hidden-count"
          >
            {t("hiddenCount", { count: hidden })}
          </Toolbar.Button>
        </Hint>
      ) : null}
    </Toolbar.Root>
  );
}

/**
 * The Activity tab: the text filter (shared with the header search; uFuzzy), the feed filters,
 * the action → consequences feed, and the raw details of the selection in a resizable pane.
 */
export function ActivityPanel() {
  const controller = useController();
  const t = useFeatureI18n(feedMessages);
  const query = usePlayerState((state) => state.query);
  const showDetails = usePlayerState(
    (state) => state.detailsOpen && state.archive !== null && state.selection !== null
  );

  return (
    <>
      <div className="rail-tools feed-tools">
        <label className="field">
          <Icon name="filter" />
          <span className="visually-hidden">{t("filterEvents")}</span>
          <input
            type="search"
            value={query}
            placeholder={t("filterEvents")}
            onChange={(event) => controller.setQuery(event.target.value)}
            data-testid="activity-filter"
          />
        </label>
        <FeedFilters />
      </div>
      <ListDetailsSplit
        name="details"
        list={<ActivityFeed />}
        details={showDetails ? <DetailsPanel /> : null}
      />
    </>
  );
}
