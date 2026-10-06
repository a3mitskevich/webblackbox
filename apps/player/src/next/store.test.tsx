/* @vitest-environment jsdom */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStore, shallowEqual, useStoreSelector } from "./store.js";

afterEach(() => {
  cleanup();
});

describe("createStore", () => {
  it("notifies subscribers on change only", () => {
    const store = createStore({ count: 0 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.setState((state) => ({ count: state.count + 1 }));
    store.setState((state) => state);
    store.setState({ count: 5 });
    unsubscribe();
    store.setState({ count: 6 });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getState()).toEqual({ count: 6 });
  });
});

describe("shallowEqual", () => {
  it("compares own keys", () => {
    expect(shallowEqual({ a: 1, b: "x" }, { a: 1, b: "x" })).toBe(true);
    expect(shallowEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(shallowEqual<unknown>(1, 1)).toBe(true);
    expect(shallowEqual<unknown>(null, {})).toBe(false);
  });
});

describe("useStoreSelector", () => {
  it("re-renders only when the selected slice changes", () => {
    const store = createStore({ count: 0, other: 0 });
    let renders = 0;

    function Counter() {
      renders += 1;
      const pair = useStoreSelector(store, (state) => ({ count: state.count }), shallowEqual);
      return <output>{pair.count}</output>;
    }

    render(<Counter />);
    const initialRenders = renders;

    act(() => store.setState((state) => ({ ...state, other: state.other + 1 })));
    expect(renders).toBe(initialRenders);

    act(() => store.setState((state) => ({ ...state, count: 3 })));
    expect(screen.getByRole("status")).toHaveProperty("textContent", "3");
    expect(renders).toBe(initialRenders + 1);
  });
});
