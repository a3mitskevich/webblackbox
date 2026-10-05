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
};

/**
 * Stage ↔ rail of the wide layout (PROPOSAL §5): a keyboard-accessible splitter
 * (react-resizable-panels, WAI-ARIA window splitter) whose sizes persist in localStorage.
 */
export function BodySplit({ stage, rail }: BodySplitProps) {
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
    >
      <Panel id="layout-stage" className="split-panel" minSize={`${STAGE_MIN_PERCENT}%`}>
        {stage}
      </Panel>
      <Separator id="split-body" className="split-handle" aria-label={i18n.tn("resizePanels")} />
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

function DetailsGroup({ name, list, details }: ListDetailsSplitProps) {
  const i18n = useI18n();
  const groupRef = useGroupRef();
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: layoutId(name),
    storage: layoutStorage,
    onlySaveAfterUserInteractions: true
  });
  const fallback: Layout = defaultDetailsLayout();

  useLayoutReset(() => groupRef.current?.setLayout(defaultDetailsLayout()));

  return (
    <Group
      className="split split-v"
      orientation="vertical"
      groupRef={groupRef}
      defaultLayout={defaultLayout ?? fallback}
      onLayoutChanged={onLayoutChanged}
    >
      <Panel id="layout-list" className="split-panel" minSize="20%">
        {list}
      </Panel>
      <Separator
        id={`split-${name}`}
        className="split-handle"
        aria-label={i18n.tn("resizeDetails")}
      />
      <Panel id="layout-details" className="split-panel" minSize="15%">
        {details}
      </Panel>
    </Group>
  );
}

/** A list with a details pane under it, split by a persisted, resettable splitter. */
export function ListDetailsSplit({ name, list, details }: ListDetailsSplitProps) {
  return details ? <DetailsGroup name={name} list={list} details={details} /> : <>{list}</>;
}
