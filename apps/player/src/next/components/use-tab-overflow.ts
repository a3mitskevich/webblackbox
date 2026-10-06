import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from "react";

/** Scroll slack (px) below which an edge counts as reached (subpixel widths, zoom). */
const EDGE_EPSILON_PX = 2;
/** A scroll button moves the row by this share of its visible width. */
const SCROLL_PAGE_SHARE = 0.8;
/** Room kept beside a tab scrolled into view, so the scroll button does not cover it. */
const EDGE_ROOM_PX = 32;

export type TabOverflow = {
  /** Tabs are hidden before the visible part (the start button is shown). */
  start: boolean;
  /** Tabs are hidden after the visible part (the end button is shown). */
  end: boolean;
};

const NO_OVERFLOW: TabOverflow = { start: false, end: false };

function readOverflow(list: HTMLElement): TabOverflow {
  const maxScroll = list.scrollWidth - list.clientWidth;
  return {
    start: list.scrollLeft > EDGE_EPSILON_PX,
    end: maxScroll - list.scrollLeft > EDGE_EPSILON_PX
  };
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function scrollListTo(list: HTMLElement, left: number): void {
  const bounded = Math.max(0, Math.min(left, list.scrollWidth - list.clientWidth));

  if (typeof list.scrollTo === "function") {
    list.scrollTo({ left: bounded, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  } else {
    list.scrollLeft = bounded;
  }
}

/** Scrolls the row just enough to show the selected tab whole (and the room beside it). */
function revealSelected(list: HTMLElement): void {
  const tab = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');

  if (!tab) {
    return;
  }

  const left = tab.offsetLeft - EDGE_ROOM_PX;
  const right = tab.offsetLeft + tab.offsetWidth + EDGE_ROOM_PX;

  if (left < list.scrollLeft) {
    scrollListTo(list, left);
  } else if (right > list.scrollLeft + list.clientWidth) {
    scrollListTo(list, right - list.clientWidth);
  }
}

/**
 * The rail's tab row scrolls sideways (as in the mockups, without a visible scrollbar). This
 * tracks which ends hide tabs, so the rail can show scroll buttons there; turns a vertical wheel
 * into a sideways scroll; and keeps the selected tab in view whenever `selected` changes (a
 * badge, the 1…7 keys, a URL hash). Keyboard users move with the tablist's arrow keys.
 */
export function useTabOverflow(
  listRef: RefObject<HTMLElement | null>,
  selected: string
): { overflow: TabOverflow; scrollPage: (direction: -1 | 1) => void } {
  const [overflow, setOverflow] = useState<TabOverflow>(NO_OVERFLOW);

  useEffect(() => {
    const list = listRef.current;

    if (!list) {
      return;
    }

    const update = (): void => {
      const next = readOverflow(list);
      setOverflow((current) =>
        current.start === next.start && current.end === next.end ? current : next
      );
    };
    const onWheel = (event: WheelEvent): void => {
      const { start, end } = readOverflow(list);

      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || (!start && !end)) {
        return;
      }

      event.preventDefault();
      list.scrollLeft += event.deltaY;
    };

    update();
    list.addEventListener("scroll", update, { passive: true });
    list.addEventListener("wheel", onWheel, { passive: false });
    // Labels and counts change width with the language and the archive.
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(list);
    [...list.children].forEach((child) => observer?.observe(child));

    return () => {
      list.removeEventListener("scroll", update);
      list.removeEventListener("wheel", onWheel);
      observer?.disconnect();
    };
  }, [listRef]);

  useLayoutEffect(() => {
    const list = listRef.current;

    if (list) {
      revealSelected(list);
    }
  }, [listRef, selected]);

  const scrollPage = useCallback(
    (direction: -1 | 1): void => {
      const list = listRef.current;

      if (list) {
        scrollListTo(list, list.scrollLeft + direction * list.clientWidth * SCROLL_PAGE_SHARE);
      }
    },
    [listRef]
  );

  return { overflow, scrollPage };
}
