import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode
} from "react";

/** Rows rendered above and below the viewport. */
const OVERSCAN = 8;

type VirtualListProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  itemCount: number;
  rowHeight: number;
  renderRow: (index: number) => ReactNode;
  /** Scrolls this row into view whenever it changes (follow playhead / selection). */
  scrollToIndex?: number | null;
  /** Extra layer positioned in list coordinates (e.g. the "now" line). */
  overlay?: ReactNode;
  testId?: string;
};

/**
 * Fixed-row-height virtual list: only the rows in (or near) the viewport are mounted, so lists of
 * tens of thousands of events stay cheap (ported from the classic `renderTimelineWindow`).
 */
export function VirtualList({
  itemCount,
  rowHeight,
  renderRow,
  scrollToIndex = null,
  overlay,
  testId,
  className,
  ...rest
}: VirtualListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(480);

  useLayoutEffect(() => {
    const element = ref.current;

    if (!element) {
      return;
    }

    setViewport(element.clientHeight || 480);

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => setViewport(element.clientHeight || 480));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = ref.current;

    if (!element || scrollToIndex === null || scrollToIndex < 0) {
      return;
    }

    const top = scrollToIndex * rowHeight;
    const bottom = top + rowHeight;

    if (top < element.scrollTop || bottom > element.scrollTop + element.clientHeight) {
      element.scrollTop = Math.max(0, top - element.clientHeight / 2 + rowHeight / 2);
      setScrollTop(element.scrollTop);
    }
  }, [scrollToIndex, rowHeight]);

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const end = Math.min(itemCount, Math.ceil((scrollTop + viewport) / rowHeight) + OVERSCAN);
  const rows: ReactNode[] = [];

  for (let index = start; index < end; index += 1) {
    rows.push(renderRow(index));
  }

  return (
    <div
      {...rest}
      ref={ref}
      className={className ? `vlist ${className}` : "vlist"}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      data-testid={testId}
    >
      <div className="vlist-canvas" style={{ height: itemCount * rowHeight }}>
        <div className="vlist-window" style={{ transform: `translateY(${start * rowHeight}px)` }}>
          {rows}
        </div>
        {overlay}
      </div>
    </div>
  );
}
