import { Tabs } from "@base-ui/react/tabs";
import { useMemo } from "react";

import { RAIL_TABS, type RailTab } from "../../core/url-hash.js";
import { useController, useI18n, usePlayerState } from "../context.js";
import { RAIL_TAB_ORDER } from "../features/registry.js";
import type { RailTabRegistration } from "../features/types.js";
import { PanelBoundary } from "./panel-boundary.js";

function isRailTab(value: unknown): value is RailTab {
  return typeof value === "string" && (RAIL_TABS as readonly string[]).includes(value);
}

function RailTabButton({ registration }: { registration: RailTabRegistration }) {
  const i18n = useI18n();
  const locale = usePlayerState((state) => state.locale);
  const archive = usePlayerState((state) => state.archive);
  const query = usePlayerState((state) => state.query);
  const count = useMemo(
    () => (archive && registration.count ? registration.count(archive, query) : null),
    [archive, query, registration]
  );
  const isAlert = count !== null && (registration.isAlert?.(count) ?? false);

  return (
    <Tabs.Tab value={registration.id} className="rail-tab" data-testid={`tab-${registration.id}`}>
      {registration.label(locale)}{" "}
      {count === null ? null : (
        <span className={isAlert ? "c bad" : "c"}>{i18n.formatNumber(count)}</span>
      )}
    </Tabs.Tab>
  );
}

/**
 * The right rail (Base UI `Tabs`): one tab per registered feature tab, in `RAIL_TABS` order.
 * Arrow keys move between tabs and activate them; each panel renders inside its own error
 * boundary, so a failing feature leaves the rest of the player working.
 */
export function Rail() {
  const controller = useController();
  const i18n = useI18n();
  const archive = usePlayerState((state) => state.archive);
  const tab = usePlayerState((state) => state.tab);

  if (!archive) {
    return null;
  }

  return (
    <Tabs.Root
      value={tab}
      onValueChange={(value) => {
        if (isRailTab(value)) {
          controller.setTab(value);
        }
      }}
      render={<aside className="rail" aria-label={i18n.tn("railLabel")} data-testid="rail" />}
    >
      <Tabs.List className="rail-tabs" aria-label={i18n.tn("railLabel")} activateOnFocus>
        {RAIL_TAB_ORDER.map((registration) => (
          <RailTabButton key={registration.id} registration={registration} />
        ))}
      </Tabs.List>
      {RAIL_TAB_ORDER.map(({ id, Panel }) => (
        <Tabs.Panel key={id} value={id} className="rail-panel" data-testid={`panel-${id}`}>
          <PanelBoundary resetKeys={[archive]}>
            <Panel />
          </PanelBoundary>
        </Tabs.Panel>
      ))}
    </Tabs.Root>
  );
}
