/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPlainArchive } from "../../../scripts/lib/synthetic-session.mjs";
import { createMediaUrlCache } from "../../core/media-cache.js";
import { App } from "../app.js";
import { createPlayerController } from "../controller.js";
import { createInitialState, type PlayerState } from "../state.js";
import { createStore } from "../store.js";

let archiveBytes: Uint8Array;

beforeAll(async () => {
  archiveBytes = await createPlainArchive();
});

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

/** A tab row of 8 tabs, 100 px each, in a 300 px wide rail (jsdom has no layout). */
const TAB_WIDTH = 100;
const ROW_WIDTH = 300;

async function openedNarrowRail() {
  const store = createStore<PlayerState>(createInitialState("en", "system"));
  const controller = createPlayerController(store, {
    scheduler: { request: () => 0, cancel: () => undefined },
    mediaCache: createMediaUrlCache({ createUrl: () => "blob:frame", revokeUrl: () => undefined })
  });
  render(<App controller={controller} />);
  await act(async () => {
    await controller.openFile({
      name: "synthetic.webblackbox",
      arrayBuffer: async () => archiveBytes.slice().buffer
    });
  });

  const list = screen.getByTestId("rail-tabs");
  const tabs = screen.getAllByRole("tab");
  Object.defineProperty(list, "clientWidth", { value: ROW_WIDTH, configurable: true });
  Object.defineProperty(list, "scrollWidth", {
    value: tabs.length * TAB_WIDTH,
    configurable: true
  });
  tabs.forEach((tab, index) => {
    Object.defineProperty(tab, "offsetLeft", { value: index * TAB_WIDTH, configurable: true });
    Object.defineProperty(tab, "offsetWidth", { value: TAB_WIDTH, configurable: true });
  });
  act(() => {
    fireEvent.scroll(list);
  });
  return { store, controller, list };
}

describe("Rail tab row", () => {
  it("shows a scroll button only at an end that hides tabs", async () => {
    const { list } = await openedNarrowRail();

    expect(screen.queryByTestId("rail-tabs-scroll-start")).not.toBeInTheDocument();
    const end = screen.getByTestId("rail-tabs-scroll-end");
    // Pointer-only: keyboard users move with the tablist's arrow keys.
    expect(end).toHaveAttribute("tabindex", "-1");

    act(() => {
      fireEvent.click(end);
    });
    expect(list.scrollLeft).toBe(ROW_WIDTH * 0.8);
    act(() => {
      fireEvent.scroll(list);
    });
    expect(screen.getByTestId("rail-tabs-scroll-start")).toBeInTheDocument();

    act(() => {
      list.scrollLeft = 8 * TAB_WIDTH - ROW_WIDTH;
      fireEvent.scroll(list);
    });
    expect(screen.queryByTestId("rail-tabs-scroll-end")).not.toBeInTheDocument();
  });

  it("scrolls a selected tab past the edge into view (keys, badge, hash)", async () => {
    const { controller, list } = await openedNarrowRail();

    act(() => {
      controller.setTab("perf");
    });
    // perf is the 7th tab (600–700 px): shown whole with 32 px of room for the end button.
    expect(list.scrollLeft).toBe(700 + 32 - ROW_WIDTH);
    expect(screen.getByTestId("tab-perf")).toHaveAttribute("aria-selected", "true");

    act(() => {
      controller.setTab("activity");
    });
    expect(list.scrollLeft).toBe(0);
  });

  it("turns a vertical wheel over the row into a sideways scroll", async () => {
    const { list } = await openedNarrowRail();

    const wheel = new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true });
    act(() => {
      list.dispatchEvent(wheel);
    });
    expect(list.scrollLeft).toBe(120);
    expect(wheel.defaultPrevented).toBe(true);
  });
});
