import { useCallback, useRef, useSyncExternalStore } from "react";

export type StoreListener = () => void;

/** A minimal external store: immutable snapshots, synchronous notification. */
export type Store<S> = {
  getState(): S;
  /** Replaces the snapshot; an updater returning the same object is a no-op. */
  setState(update: S | ((state: S) => S)): void;
  subscribe(listener: StoreListener): () => void;
};

export function createStore<S>(initialState: S): Store<S> {
  let state = initialState;
  const listeners = new Set<StoreListener>();

  return {
    getState: () => state,
    setState(update) {
      const next = typeof update === "function" ? (update as (current: S) => S)(state) : update;

      if (Object.is(next, state)) {
        return;
      }

      state = next;

      for (const listener of [...listeners]) {
        listener();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

/** Shallow equality for selectors that return small objects or arrays. */
export function shallowEqual<T>(left: T, right: T): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);

  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) =>
      Object.is((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key])
    )
  );
}

/**
 * Subscribes a component to a slice of the store (`useSyncExternalStore`). The selected value is
 * memoized per snapshot, and `isEqual` keeps the previous value when the slice did not change, so
 * selectors may build small objects without re-rendering on every store update.
 */
export function useStoreSelector<S, T>(
  store: Store<S>,
  selector: (state: S) => T,
  isEqual: (left: T, right: T) => boolean = Object.is
): T {
  const memo = useRef<{ state: S; selector: (state: S) => T; value: T } | null>(null);

  const getSnapshot = useCallback((): T => {
    const state = store.getState();
    const previous = memo.current;

    // A new selector (e.g. one closing over changed props) recomputes even for the same snapshot.
    if (previous && Object.is(previous.state, state) && previous.selector === selector) {
      return previous.value;
    }

    const selected = selector(state);
    const value = previous && isEqual(previous.value, selected) ? previous.value : selected;
    memo.current = { state, selector, value };
    return value;
  }, [store, selector, isEqual]);

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
