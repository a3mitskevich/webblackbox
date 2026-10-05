import { Icon } from "../../components/icon.js";
import { ListDetailsSplit } from "../../components/split-layout.js";
import { useController, usePlayerState } from "../../context.js";
import { useFeatureI18n } from "../messages.js";
import { EventList } from "./event-list.js";
import { feedMessages } from "./messages.js";

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

/**
 * The Activity tab of R1: a text filter, every meaningful event with the "now" line, and the raw
 * details of the selection in a resizable pane under the list. R2 replaces it with the
 * action → consequences feed.
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
      <div className="rail-tools">
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
      </div>
      <ListDetailsSplit
        name="details"
        list={<EventList />}
        details={showDetails ? <DetailsPanel /> : null}
      />
    </>
  );
}
