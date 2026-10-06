/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PlayerProvider } from "../context.js";
import { createPlayerController } from "../controller.js";
import { createInitialState, type PlayerState } from "../state.js";
import { createStore } from "../store.js";
import { defineFeatureSlice, useFeatureSlice, useFeatureSliceUpdate } from "./slice.js";

// How a feature declares its slice (here a test-only key; features do this in their folder).
declare module "../state.js" {
  interface FeatureSlices {
    sliceTest: { count: number; label: string };
  }
}

const testSlice = defineFeatureSlice("sliceTest", { count: 0, label: "start" });

afterEach(() => {
  cleanup();
});

describe("feature slices", () => {
  it("reads the initial slice until the feature writes it, then updates immutably", () => {
    const store = createStore<PlayerState>(createInitialState("en", "system"));
    const before = store.getState();

    expect(testSlice.select(before)).toEqual({ count: 0, label: "start" });

    testSlice.update(store, (slice) => ({ ...slice, count: slice.count + 1 }));

    const after = store.getState();
    expect(testSlice.select(after)).toEqual({ count: 1, label: "start" });
    expect(after.slices).not.toBe(before.slices);
    expect(before.slices).toEqual({});
    expect(after.playheadMono).toBe(before.playheadMono);
  });

  it("notifies nobody when the updater returns the same slice", () => {
    const store = createStore<PlayerState>(createInitialState("en", "system"));
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });

    testSlice.update(store, (slice) => slice);

    expect(notified).toBe(0);
  });

  it("re-renders a consumer only when its part of the slice changes", () => {
    const store = createStore<PlayerState>(createInitialState("en", "system"));
    const controller = createPlayerController(store, {
      scheduler: { request: () => 0, cancel: () => undefined }
    });
    let renders = 0;
    let bump: (() => void) | null = null;
    const selectCount = (slice: { count: number }) => slice.count;

    function Counter() {
      const count = useFeatureSlice(testSlice, selectCount);
      const update = useFeatureSliceUpdate(testSlice);
      renders += 1;
      bump = () => update((slice) => ({ ...slice, count: slice.count + 1 }));
      return <output data-testid="count">{count}</output>;
    }

    render(
      <PlayerProvider controller={controller}>
        <Counter />
      </PlayerProvider>
    );
    const initialRenders = renders;

    act(() => {
      testSlice.update(store, (slice) => ({ ...slice, label: "other" }));
      store.setState((state) => ({ ...state, playheadMono: 1_000 }));
    });
    expect(renders).toBe(initialRenders);

    act(() => bump?.());
    expect(screen.getByTestId("count")).toHaveTextContent("1");
    expect(renders).toBe(initialRenders + 1);
  });
});
