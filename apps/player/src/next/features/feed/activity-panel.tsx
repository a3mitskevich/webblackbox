import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { Toolbar } from "@base-ui/react/toolbar";
import { lazy, Suspense, useEffect, useMemo, useRef } from "react";

import "./feed.css";

import type { ScopeFilter } from "../../../lib/scope.js";
import { Hint } from "../../components/hint.js";
import { Icon } from "../../components/icon.js";
import { toastManager } from "../../components/toasts.js";
import { useController, usePlayerState } from "../../context.js";
import { resolveSelectedEventId } from "../../controller.js";
import { useFeatureI18n } from "../messages.js";
import { useFeatureSlice, useFeatureSliceUpdate } from "../slice.js";
import { ActivityFeed } from "./activity-feed.js";
import { feedDataOf, feedViewOf } from "./feed-view.js";
import { feedMessages } from "./messages.js";
import { feedSlice, type FeedSlice } from "./slice.js";

const SCOPES: readonly ScopeFilter[] = ["all", "main", "iframe"];

/** The event inspector (R5) loads its own chunk the first time it opens. */
const InspectorPanel = lazy(() => import("../inspector/inspector-panel.js"));

function isScope(value: unknown): value is ScopeFilter {
  return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}

/** All / Main / Iframe (classic scope filter), shown only for recordings with iframe activity. */
function ScopeToggle() {
  const t = useFeatureI18n(feedMessages);
  const archive = usePlayerState((state) => state.archive);
  const scope = useFeatureSlice(feedSlice, (slice) => slice.scope);
  const update = useFeatureSliceUpdate(feedSlice);
  const counts = archive ? feedDataOf(archive).scopeCounts : null;

  if (!counts || counts.iframe === 0) {
    return null;
  }

  return (
    <ToggleGroup
      className="scope-toggle"
      aria-label={t("scopeLabel")}
      value={[scope]}
      onValueChange={(value) => {
        const next = value[0];
        update((current) => ({ ...current, scope: isScope(next) ? next : "all" }));
      }}
      data-testid="feed-scope"
    >
      <Toggle className="fchip" value="all">
        {t("scopeAll")}
      </Toggle>
      <Toggle className="fchip" value="main">
        {t("scopeMain", { count: counts.main })}
      </Toggle>
      <Toggle className="fchip" value="iframe">
        {t("scopeIframe", { count: counts.iframe })}
      </Toggle>
    </ToggleGroup>
  );
}

const selectSlice = (slice: FeedSlice): FeedSlice => slice;

/** "Errors only", "Hide third-party" and the "N hidden" chip (Base UI Toolbar + Toggle). */
function FeedFilters() {
  const t = useFeatureI18n(feedMessages);
  const archive = usePlayerState((state) => state.archive);
  const range = usePlayerState((state) => state.range);
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
        ? feedViewOf(archive, { ...slice, query, selectedEventId, locale, range }).hiddenThirdParty
        : 0,
    [archive, slice, query, selectedEventId, locale, range]
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
 * The Activity tab: the text filter (shared with the header search; uFuzzy), the feed filters and
 * the action → consequences feed; Enter (or "Inspect") swaps the list for the event inspector.
 */
export function ActivityPanel() {
  const controller = useController();
  const t = useFeatureI18n(feedMessages);
  const query = usePlayerState((state) => state.query);
  const showInspector = usePlayerState(
    (state) => state.detailsOpen && state.archive !== null && state.selection !== null
  );
  const paneRef = useRef<HTMLDivElement>(null);
  const wasInspecting = useRef(showInspector);

  // Closing the inspector (Esc, "Activity") unmounts it: focus returns to the list.
  useEffect(() => {
    const focusLost = !document.activeElement || document.activeElement === document.body;

    if (wasInspecting.current && !showInspector && focusLost) {
      paneRef.current
        ?.querySelector<HTMLElement>("[role='listbox']")
        ?.focus({ preventScroll: true });
    }

    wasInspecting.current = showInspector;
  }, [showInspector]);

  if (showInspector) {
    return (
      <Suspense fallback={null}>
        <InspectorPanel />
      </Suspense>
    );
  }

  return (
    <div ref={paneRef} className="activity-pane">
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
        <ScopeToggle />
      </div>
      <ActivityFeed />
    </div>
  );
}
