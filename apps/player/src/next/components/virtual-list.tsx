import {
  observeElementRect,
  useVirtualizer,
  type Rect,
  type Virtualizer
} from "@tanstack/react-virtual";
import { useEffect, useRef, type HTMLAttributes, type ReactNode } from "react";

/** Rows rendered above and below the viewport. */
const OVERSCAN = 8;
/** A list that is not laid out yet (hidden, or jsdom) still renders a first window of rows. */
const FALLBACK_VIEWPORT_HEIGHT = 480;

type VirtualListProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  itemCount: number;
  /** Row height (the estimate TanStack Virtual starts from; rows are fixed-height today). */
  rowHeight: number;
  renderRow: (index: number) => ReactNode;
  /** Scrolls this row into view whenever it changes (follow playhead / selection). */
  scrollToIndex?: number | null;
  /** Extra layer positioned in list coordinates (e.g. the "now" line). */
  overlay?: ReactNode;
  testId?: string;
};

function observeRectWithFallback(
  instance: Virtualizer<HTMLDivElement, Element>,
  onRect: (rect: Rect) => void
): void | (() => void) {
  return observeElementRect(instance, (rect) =>
    onRect(rect.height > 0 ? rect : { width: rect.width, height: FALLBACK_VIEWPORT_HEIGHT })
  );
}

/**
 * A virtual list on `@tanstack/react-virtual`: only the rows in (or near) the viewport are
 * mounted, so lists of tens of thousands of events stay cheap. Our own markup keeps the
 * `data-testid` and ARIA hooks; variable row heights (R2) only need `measureElement`.
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
  const virtualizer = useVirtualizer({
    count: itemCount,
    getScrollElement: () => ref.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
    observeElementRect: observeRectWithFallback,
    // React 19 warns about flushSync inside lifecycle methods (LIBRARIES.md).
    useFlushSync: false
  });

  useEffect(() => {
    const element = ref.current;

    if (!element || scrollToIndex === null || scrollToIndex < 0 || scrollToIndex >= itemCount) {
      return;
    }

    const row = virtualizer.measurementsCache[scrollToIndex];
    const top = row?.start ?? scrollToIndex * rowHeight;
    const bottom = row?.end ?? top + rowHeight;

    // Only when the row is (partly) out of view: following the playhead must not jitter.
    if (top < element.scrollTop || bottom > element.scrollTop + element.clientHeight) {
      virtualizer.scrollToIndex(scrollToIndex, { align: "center" });
    }
  }, [scrollToIndex, rowHeight, itemCount, virtualizer]);

  const rows = virtualizer.getVirtualItems();
  const offset = rows[0]?.start ?? 0;

  return (
    <div
      {...rest}
      ref={ref}
      className={className ? `vlist ${className}` : "vlist"}
      data-testid={testId}
    >
      <div className="vlist-canvas" style={{ height: virtualizer.getTotalSize() }}>
        <div className="vlist-window" style={{ transform: `translateY(${offset}px)` }}>
          {rows.map((row) => renderRow(row.index))}
        </div>
        {overlay}
      </div>
    </div>
  );
}
