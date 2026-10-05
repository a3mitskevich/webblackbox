import type { ReactNode } from "react";

import { Hint } from "../../components/hint.js";
import { Icon } from "../../components/icon.js";
import { ListDetailsSplit } from "../../components/split-layout.js";
import { useController, useI18n, usePlayerState } from "../../context.js";
import { useFeatureI18n } from "../messages.js";
import { useFeatureSlice, useFeatureSliceUpdate } from "../slice.js";
import { NetworkDetails } from "./details.js";
import { networkMessages } from "./messages.js";
import { NetworkTable } from "./network-table.js";
import {
  findSlowestRow,
  NETWORK_TYPE_CHIPS,
  selectionOfRow,
  type NetworkCounts,
  type NetworkModel
} from "./rows.js";
import { networkSlice, type NetworkSlice } from "./slice.js";
import { useNetworkModel, useNetworkView, useSelectedRow } from "./use-network.js";
import "./network.css";

type ToggleKey = "failedOnly" | "notCapturedOnly" | "hideThirdParty";

function Chip({
  pressed,
  onClick,
  children,
  testId
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
  testId: string;
}) {
  return (
    <button
      type="button"
      className={pressed ? "fchip on" : "fchip"}
      aria-pressed={pressed}
      onClick={onClick}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

const selectWhole = (slice: NetworkSlice) => slice;

/** Text filter (the player-wide query), type chips, toggles, counts, Slowest and Full width. */
function NetworkTools({
  model,
  counts,
  shown,
  hiddenThirdParty
}: {
  model: NetworkModel;
  counts: NetworkCounts;
  shown: number;
  hiddenThirdParty: number;
}) {
  const controller = useController();
  const t = useFeatureI18n(networkMessages);
  const i18n = useI18n();
  const query = usePlayerState((state) => state.query);
  const railWide = usePlayerState((state) => state.railWide);
  const slice = useFeatureSlice(networkSlice, selectWhole);
  const update = useFeatureSliceUpdate(networkSlice);
  const flip = (key: ToggleKey) =>
    update((value): NetworkSlice => ({ ...value, [key]: !value[key] }));
  const count = (value: number) => <span className="c mono">{i18n.formatNumber(value)}</span>;

  const selectSlowest = () => {
    const slowest = findSlowestRow(model.rows);
    const selection = slowest ? selectionOfRow(slowest) : null;

    if (selection) {
      controller.select(selection);
      controller.openDetails();
    }
  };

  return (
    <div className="rail-tools net-tools">
      <label className="field">
        <Icon name="filter" />
        <span className="visually-hidden">{t("filterLabel")}</span>
        <input
          type="search"
          value={query}
          placeholder={t("filterPlaceholder")}
          onChange={(event) => controller.setQuery(event.target.value)}
          data-testid="network-filter"
        />
      </label>
      <div className="chips" role="group" aria-label={t("typeChipsLabel")}>
        {NETWORK_TYPE_CHIPS.map((chip) => (
          <Chip
            key={chip}
            pressed={slice.type === chip}
            onClick={() => update((value) => ({ ...value, type: chip }))}
            testId={`net-type-${chip}`}
          >
            {t(`type_${chip}`)}
            {chip === "all" ? null : count(counts[chip])}
          </Chip>
        ))}
      </div>
      <div className="chips">
        <Chip pressed={slice.failedOnly} onClick={() => flip("failedOnly")} testId="net-failed">
          {t("failedOnly")} {count(counts.failed)}
        </Chip>
        <Chip
          pressed={slice.notCapturedOnly}
          onClick={() => flip("notCapturedOnly")}
          testId="net-not-captured"
        >
          {t("notCapturedOnly")} {count(counts.notCaptured)}
        </Chip>
        <Chip
          pressed={slice.hideThirdParty}
          onClick={() => flip("hideThirdParty")}
          testId="net-hide-third-party"
        >
          {t("hideThirdParty")}
        </Chip>
        {hiddenThirdParty > 0 ? (
          <span className="muted small" data-testid="net-hidden-count">
            {t("hiddenThirdParty", { count: i18n.formatNumber(hiddenThirdParty) })}
          </span>
        ) : null}
      </div>
      <span className="grow" />
      <span className="mono muted small" data-testid="net-shown">
        {t("rowsShown", {
          shown: i18n.formatNumber(shown),
          total: i18n.formatNumber(model.rows.length)
        })}
      </span>
      <Hint label={t("slowestHint")}>
        <button
          type="button"
          className="btn small icon-only"
          aria-label={t("slowest")}
          onClick={selectSlowest}
          data-testid="net-slowest"
        >
          <Icon name="slowest" />
        </button>
      </Hint>
      <Hint label={t("railWideHint")}>
        <button
          type="button"
          className="btn small icon-only"
          aria-label={railWide ? t("railWideOff") : t("railWide")}
          aria-pressed={railWide}
          onClick={() => controller.toggleRailWide()}
          data-testid="rail-wide"
        >
          <Icon name={railWide ? "narrow" : "widen"} />
        </button>
      </Hint>
    </div>
  );
}

/**
 * The Network rail tab (PROPOSAL §12 B2.3): filters, the dense request table and, under a
 * persisted splitter, the details of the selected request or socket.
 */
export default function NetworkPanel() {
  const t = useFeatureI18n(networkMessages);
  const model = useNetworkModel();
  const view = useNetworkView(model);
  const selected = useSelectedRow(model);
  const detailsOpen = usePlayerState((state) => state.detailsOpen);

  if (!model || !view) {
    return null;
  }

  const list =
    view.rows.length === 0 ? (
      <p className="list-empty" data-testid="network-empty">
        {model.rows.length === 0 ? t("emptyArchive") : t("emptyFilter")}
      </p>
    ) : (
      <NetworkTable model={model} rows={view.rows} selected={selected} />
    );

  return (
    <>
      <NetworkTools
        model={model}
        counts={view.counts}
        shown={view.rows.length}
        hiddenThirdParty={view.hiddenThirdParty}
      />
      <ListDetailsSplit
        name="network"
        list={list}
        details={detailsOpen && selected ? <NetworkDetails row={selected} /> : null}
      />
    </>
  );
}
