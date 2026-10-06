import type { EndpointAlignment, EndpointSummary } from "@webblackbox/player-sdk";
import { memo, useMemo } from "react";

import { useI18n } from "../../context.js";
import type { CompareTranslate } from "./messages.js";

/** Rows rendered at most: a recording can have thousands of endpoints. */
export const MAX_ENDPOINT_ROWS = 300;

type FormatMs = (ms: number) => string;

function SideCell({
  summary,
  t,
  format
}: {
  summary: EndpointSummary | null;
  t: CompareTranslate;
  format: FormatMs;
}) {
  if (!summary) {
    return <>—</>;
  }

  return (
    <>
      {t("endpointSide", { count: summary.count, p95: format(summary.p95Ms) })}
      {summary.failureCount > 0 ? (
        <span className="failed"> · {t("endpointFailed", { count: summary.failureCount })}</span>
      ) : null}
    </>
  );
}

type EndpointRowProps = {
  row: EndpointAlignment;
  isSelected: boolean;
  diffId: string;
  onSelect: (row: EndpointAlignment) => void;
  t: CompareTranslate;
  format: FormatMs;
};

/** Memoized: picking an endpoint re-renders the two rows whose selection changed. */
const EndpointRow = memo(function EndpointRow({
  row,
  isSelected,
  diffId,
  onSelect,
  t,
  format
}: EndpointRowProps) {
  return (
    <tr
      className={isSelected ? "cur" : undefined}
      aria-current={isSelected ? "true" : undefined}
      onClick={() => onSelect(row)}
      data-testid="compare-endpoint-row"
      data-signal={row.signal}
    >
      <td className="mono ep" title={row.key}>
        <button
          type="button"
          className="linklike"
          aria-expanded={isSelected}
          aria-controls={diffId}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(row);
          }}
        >
          {row.key}
        </button>
      </td>
      <td className="mono">
        <SideCell summary={row.left} t={t} format={format} />
      </td>
      <td className="mono">
        <SideCell summary={row.right} t={t} format={format} />
      </td>
      <td>
        <span className={`sig sig-${row.signal}`}>{t(`signal_${row.signal}`)}</span>
      </td>
    </tr>
  );
});

type EndpointTableProps = {
  rows: readonly EndpointAlignment[];
  selectedKey: string | null;
  /** Id of the response diff region the endpoint buttons open. */
  diffId: string;
  onSelect: (row: EndpointAlignment) => void;
  t: CompareTranslate;
};

/** Endpoints of A and B side by side; the first `MAX_ENDPOINT_ROWS` are rendered. */
export function EndpointTable({ rows, selectedKey, diffId, onSelect, t }: EndpointTableProps) {
  const i18n = useI18n();
  const format = useMemo<FormatMs>(
    () => (value) => i18n.formatMilliseconds(value, { fractionDigits: 0 }),
    [i18n]
  );
  const shown = useMemo(() => rows.slice(0, MAX_ENDPOINT_ROWS), [rows]);

  return (
    <>
      <table className="cmp-table" data-testid="compare-endpoints">
        <thead>
          <tr>
            <th>{t("endpoint")}</th>
            <th>{t("sideA")}</th>
            <th>{t("sideB")}</th>
            <th>{t("signal")}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <EndpointRow
              key={row.key}
              row={row}
              isSelected={row.key === selectedKey}
              diffId={diffId}
              onSelect={onSelect}
              t={t}
              format={format}
            />
          ))}
        </tbody>
      </table>
      {rows.length > shown.length ? (
        <p className="muted" data-testid="compare-endpoints-capped">
          {t("endpointsShown", {
            shown: i18n.formatNumber(shown.length),
            total: i18n.formatNumber(rows.length)
          })}
        </p>
      ) : null}
    </>
  );
}
