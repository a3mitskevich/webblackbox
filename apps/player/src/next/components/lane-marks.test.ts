/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LANE_MARK_TARGET_PX, useLaneCapacity } from "./lane-marks.js";

/** Only `clientWidth` is read from the track. */
function trackOf(width: number): HTMLElement {
  return { clientWidth: width } as HTMLElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useLaneCapacity", () => {
  it("is unlimited until a track is measured, then fits one mark per 24 px", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        disconnect(): void {}
      }
    );
    const { result } = renderHook(() => useLaneCapacity());
    expect(result.current[0]).toBe(Number.POSITIVE_INFINITY);

    act(() => result.current[1](trackOf(LANE_MARK_TARGET_PX * 10 + 5)));
    expect(result.current[0]).toBe(10);

    // A track that mounts later (another archive, a lane that was empty) is measured too.
    act(() => result.current[1](null));
    act(() => result.current[1](trackOf(LANE_MARK_TARGET_PX * 4)));
    expect(result.current[0]).toBe(4);
  });
});
