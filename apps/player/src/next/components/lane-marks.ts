import { useCallback, useEffect, useState, type KeyboardEvent, type RefObject } from "react";

/** A lane mark is a 24 px target (WCAG 2.5.8): a lane keeps at most one mark per 24 px of track. */
export const LANE_MARK_TARGET_PX = 24;

const ROVING_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

/** How many marks fit side by side on the track; unlimited until it is measured. */
export function useLaneCapacity(ref: RefObject<HTMLElement | null>): number {
  const [capacity, setCapacity] = useState(Number.POSITIVE_INFINITY);

  useEffect(() => {
    const element = ref.current;

    if (!element || typeof ResizeObserver !== "function") {
      return undefined;
    }

    const measure = () => {
      const width = element.clientWidth;
      setCapacity(
        width > 0 ? Math.max(1, Math.floor(width / LANE_MARK_TARGET_PX)) : Number.POSITIVE_INFINITY
      );
    };
    const observer = new ResizeObserver(measure);
    measure();
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return capacity;
}

export type RovingLane = {
  tabIndexOf: (index: number) => 0 | -1;
  /** The mark the user focused or clicked becomes the lane's tab stop. */
  focusIndex: (index: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
};

/**
 * One tab stop per lane (the WAI-ARIA toolbar pattern): ← / → / Home / End move between its
 * marks, so a dense lane does not cost a Tab press per mark.
 */
export function useRovingLane(count: number): RovingLane {
  const [active, setActive] = useState(0);
  const current = Math.min(active, Math.max(0, count - 1));

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (!ROVING_KEYS.has(event.key)) {
      return;
    }

    const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>(":scope > button")];
    const index = buttons.indexOf(event.target as HTMLElement);

    if (index < 0 || buttons.length === 0) {
      return;
    }

    const last = buttons.length - 1;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? last
          : Math.min(last, Math.max(0, index + (event.key === "ArrowRight" ? 1 : -1)));
    event.preventDefault();
    setActive(next);
    buttons[next]?.focus();
  }, []);

  return {
    tabIndexOf: (index) => (index === current ? 0 : -1),
    focusIndex: setActive,
    onKeyDown
  };
}
