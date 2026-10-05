import { useMemo, useState, type KeyboardEvent } from "react";

import { Icon } from "../../components/icon.js";
import { VirtualList } from "../../components/virtual-list.js";
import { useI18n } from "../../context.js";
import { useFeatureI18n } from "../messages.js";
import { CopyButton } from "./copy-button.js";
import { hexRow, hexRowCount } from "./formatters.js";
import {
  allContainerPaths,
  defaultExpandedPaths,
  flattenJson,
  scalarText,
  type JsonTreeRow
} from "./json-tree-model.js";
import { networkMessages } from "./messages.js";

const TREE_ROW_HEIGHT = 22;
const HEX_ROW_HEIGHT = 19;
/** "Expand all" opens at most this many containers (a huge body stays responsive). */
const EXPAND_ALL_LIMIT = 2_000;
const INDENT_PX = 14;

type JsonTreeProps = {
  value: unknown;
  testId?: string;
};

function rowDomId(path: string): string {
  return `jt-${encodeURIComponent(path).replaceAll("%", "_")}`;
}

/**
 * A JSON value as a virtualized tree (LIBRARIES.md: built here, no library virtualizes): only the
 * open containers' children are rows. Arrows move and open/close, Copy path / Copy value per row.
 * Remount it (React `key`) for a new value.
 */
export function JsonTree({ value, testId }: JsonTreeProps) {
  const t = useFeatureI18n(networkMessages);
  const i18n = useI18n();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => defaultExpandedPaths(value));
  const [focused, setFocused] = useState(0);
  const rows = useMemo(() => flattenJson(value, expanded), [value, expanded]);
  const focusIndex = Math.min(focused, rows.length - 1);
  const current = rows[focusIndex];

  const toggle = (row: JsonTreeRow, open = !row.expanded): void => {
    if (row.childCount === 0 || open === row.expanded) {
      return;
    }

    setExpanded((paths) => {
      const next = new Set(paths);

      if (open) {
        next.add(row.path);
      } else {
        next.delete(row.path);
      }

      return next;
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!current) {
      return;
    }

    const moves: Record<string, () => void> = {
      ArrowDown: () => setFocused(Math.min(rows.length - 1, focusIndex + 1)),
      ArrowUp: () => setFocused(Math.max(0, focusIndex - 1)),
      ArrowRight: () => toggle(current, true),
      ArrowLeft: () => toggle(current, false),
      Home: () => setFocused(0),
      End: () => setFocused(rows.length - 1)
    };
    const move = moves[event.key];

    if (move) {
      event.preventDefault();
      move();
    }
  };

  const summary = (row: JsonTreeRow): string =>
    row.kind === "array"
      ? t("itemsCount", { count: i18n.formatNumber(row.childCount) })
      : t("keysCount", { count: i18n.formatNumber(row.childCount) });

  return (
    <div className="json-tree" data-testid={testId}>
      <div className="viewer-tools">
        <button
          type="button"
          className="btn small"
          onClick={() => setExpanded(allContainerPaths(value, EXPAND_ALL_LIMIT))}
        >
          {t("expandAll")}
        </button>
        <button type="button" className="btn small" onClick={() => setExpanded(new Set(["$"]))}>
          {t("collapseAll")}
        </button>
        <span className="grow" />
        {current ? (
          <>
            <span className="mono muted path-readout" data-testid="json-path">
              {current.path}
            </span>
            <CopyButton compact label={t("copyPath")} getText={() => current.path} />
            <CopyButton
              compact
              label={t("copyValue")}
              getText={() =>
                current.kind === "object" || current.kind === "array"
                  ? JSON.stringify(current.value, null, 2)
                  : scalarText(current)
              }
            />
          </>
        ) : null}
      </div>
      <VirtualList
        role="tree"
        tabIndex={0}
        aria-label={t("jsonTreeLabel")}
        aria-activedescendant={current ? rowDomId(current.path) : undefined}
        className="tree-list"
        itemCount={rows.length}
        rowHeight={TREE_ROW_HEIGHT}
        scrollToIndex={focusIndex}
        onKeyDown={handleKeyDown}
        testId={testId ? `${testId}-rows` : undefined}
        renderRow={(index) => {
          const row = rows[index];

          if (!row) {
            return null;
          }

          const isContainer = row.kind === "object" || row.kind === "array";

          return (
            <div
              key={row.path}
              id={rowDomId(row.path)}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-expanded={isContainer && row.childCount > 0 ? row.expanded : undefined}
              aria-selected={index === focusIndex}
              className={index === focusIndex ? "jt-row cur" : "jt-row"}
              style={{ paddingLeft: 8 + row.depth * INDENT_PX }}
              onClick={() => {
                setFocused(index);
                toggle(row);
              }}
              data-testid="json-row"
            >
              <span className="jt-twist" aria-hidden="true">
                {isContainer && row.childCount > 0 ? (
                  <Icon name={row.expanded ? "collapse" : "expand"} />
                ) : null}
              </span>
              {row.key !== null ? (
                <span className={typeof row.key === "number" ? "jt-key jt-index" : "jt-key"}>
                  {typeof row.key === "number" ? row.key : JSON.stringify(row.key)}
                  <span className="jt-colon">: </span>
                </span>
              ) : null}
              {isContainer ? (
                <span className="jt-summary">
                  {row.kind === "array" ? "[" : "{"}
                  {row.expanded || row.childCount === 0 ? "" : "…"}
                  {row.expanded ? "" : row.kind === "array" ? "]" : "}"}{" "}
                  <span className="muted">{summary(row)}</span>
                </span>
              ) : (
                <span className={`jt-value jt-${row.kind}`}>{scalarText(row)}</span>
              )}
            </div>
          );
        }}
      />
    </div>
  );
}

type HexViewProps = {
  bytes: Uint8Array;
  testId?: string;
};

/** 16 bytes per row: offset, hex, ASCII; virtualized (LIBRARIES.md: built here). */
export function HexView({ bytes, testId }: HexViewProps) {
  const t = useFeatureI18n(networkMessages);

  return (
    <VirtualList
      className="hex"
      aria-label={t("hexLabel")}
      itemCount={hexRowCount(bytes.byteLength)}
      rowHeight={HEX_ROW_HEIGHT}
      testId={testId}
      renderRow={(index) => {
        const row = hexRow(bytes, index);
        return (
          <div key={index} className="hex-row">
            <span className="hex-offset">{row.offset}</span>
            <span className="hex-bytes">{row.hex}</span>
            <span className="hex-ascii">{row.ascii}</span>
          </div>
        );
      }}
    />
  );
}
