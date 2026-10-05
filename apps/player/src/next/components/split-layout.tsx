import { useEffect, useRef, type ReactNode } from "react";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
  useGroupRef,
  type Layout
} from "react-resizable-panels";

import { useI18n, usePlayerState } from "../context.js";
import {
  clearStoredLayouts,
  defaultBodyLayout,
  defaultDetailsLayout,
  DETAILS_DEFAULT_PERCENT,
  defaultRailWidth,
  layoutId,
  layoutStorage,
  RAIL_MIN_WIDTH_PX,
  STAGE_MIN_PERCENT
} from "../layout.js";

/** Runs `reset` (with the stored sizes dropped) each time "Reset layout" is pressed. */
function useLayoutReset(reset: () => void): void {
  const revision = usePlayerState((state) => state.layoutRevision);
  const handled = useRef(revision);
  const resetRef = useRef(reset);
  resetRef.current = reset;

  useEffect(() => {
    if (revision === handled.current) {
      return;
    }

    handled.current = revision;
    clearStoredLayouts(window.localStorage);
    resetRef.current();
  }, [revision]);
}

type BodySplitProps = {
  stage: ReactNode;
  rail: ReactNode;
  /**
   * One column (below 900 px): no splitter, and `.body-stacked` lets the group and its panels
   * step aside (`display: contents`), so stage and rail stack without being remounted.
   */
  stacked?: boolean;
};

/**
 * Stage ↔ rail of the wide layout (PROPOSAL §5): a keyboard-accessible splitter
 * (react-resizable-panels, WAI-ARIA window splitter) whose sizes persist in localStorage.
 */
export function BodySplit({ stage, rail, stacked = false }: BodySplitProps) {
  const i18n = useI18n();
  const groupRef = useGroupRef();
  const elementRef = useRef<HTMLDivElement>(null);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: layoutId("body"),
    storage: layoutStorage,
    onlySaveAfterUserInteractions: true
  });

  useLayoutReset(() => {
    const width = elementRef.current?.offsetWidth ?? window.innerWidth;
    groupRef.current?.setLayout(defaultBodyLayout(width, window.innerWidth));
  });

  return (
    <Group
      className="split"
      orientation="horizontal"
      groupRef={groupRef}
      elementRef={elementRef}
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      disabled={stacked}
    >
      <Panel id="layout-stage" className="split-panel" minSize={`${STAGE_MIN_PERCENT}%`}>
        {stage}
      </Panel>
      {stacked ? null : (
        <Separator id="split-body" className="split-handle" aria-label={i18n.tn("resizePanels")} />
      )}
      <Panel
        id="layout-rail"
        className="split-panel"
        defaultSize={`${defaultRailWidth(window.innerWidth)}px`}
        minSize={`${RAIL_MIN_WIDTH_PX}px`}
        maxSize={`${100 - STAGE_MIN_PERCENT}%`}
      >
        {rail}
      </Panel>
    </Group>
  );
}

type ListDetailsSplitProps = {
  /** Storage name of this split (one per list, e.g. `"details"`, `"network"`). */
  name: string;
  list: ReactNode;
  /** The details pane, or `null` while nothing is open (the list takes the whole height). */
  details: ReactNode | null;
};

const LIST_PANEL = "layout-list";
const DETAILS_PANEL = "layout-details";
/** The panels while the details are open; the stored sizes are kept for this set. */
const LIST_DETAILS_PANELS = [LIST_PANEL, DETAILS_PANEL];
const LIST_ONLY_LAYOUT: Layout = { [LIST_PANEL]: 100 };

/**
 * A list with a details pane under it, split by a persisted, resettable splitter. The group and
 * the list panel stay mounted while the details open and close, so the list keeps its focus,
 * scroll position and virtualizer state; only the splitter and the details panel come and go.
 */
export function ListDetailsSplit({ name, list, details }: ListDetailsSplitProps) {
  const i18n = useI18n();
  const groupRef = useGroupRef();
  const isOpen = details !== null;
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: layoutId(name),
    panelIds: LIST_DETAILS_PANELS,
    storage: layoutStorage,
    onlySaveAfterUserInteractions: true
  });
  const openLayout = defaultLayout ?? defaultDetailsLayout();
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  useLayoutReset(() =>
    groupRef.current?.setLayout(isOpenRef.current ? defaultDetailsLayout() : LIST_ONLY_LAYOUT)
  );

  return (
    <Group
      className="split split-v"
      orientation="vertical"
      groupRef={groupRef}
      defaultLayout={isOpen ? openLayout : LIST_ONLY_LAYOUT}
      onLayoutChanged={onLayoutChanged}
    >
      <Panel id={LIST_PANEL} className="split-panel" minSize="20%">
        {list}
      </Panel>
      {isOpen ? (
        <Separator
          id={`split-${name}`}
          className="split-handle"
          aria-label={i18n.tn("resizeDetails")}
        />
      ) : null}
      {isOpen ? (
        <Panel
          id={DETAILS_PANEL}
          className="split-panel"
          minSize="15%"
          defaultSize={`${openLayout[DETAILS_PANEL] ?? DETAILS_DEFAULT_PERCENT}%`}
        >
          {details}
        </Panel>
      ) : null}
    </Group>
  );
}
