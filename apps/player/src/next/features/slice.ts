import { useCallback } from "react";

import { useController, usePlayerState } from "../context.js";
import type { FeatureSlices, PlayerState } from "../state.js";
import type { Store } from "../store.js";

export type FeatureSliceKey = keyof FeatureSlices;

/** Reads and writes one feature's slice of the shared external store. */
export type FeatureSlice<K extends FeatureSliceKey> = {
  key: K;
  initial: FeatureSlices[K];
  /** The slice in a snapshot (the initial value until the feature first writes it). */
  select(state: PlayerState): FeatureSlices[K];
  /** Immutable update; an updater that returns the same slice notifies nobody. */
  update(store: Store<PlayerState>, updater: (slice: FeatureSlices[K]) => FeatureSlices[K]): void;
};

/**
 * A feature's state lives in `PlayerState.slices[key]` of the one external store, so it is part
 * of the same snapshot as the playhead and selection (one source of truth, no second store).
 * Declare the slice type by augmenting `FeatureSlices` in the feature folder (see state.ts).
 */
export function defineFeatureSlice<K extends FeatureSliceKey>(
  key: K,
  initial: FeatureSlices[K]
): FeatureSlice<K> {
  const select = (state: PlayerState): FeatureSlices[K] =>
    (state.slices[key] as FeatureSlices[K] | undefined) ?? initial;

  return {
    key,
    initial,
    select,
    update(store, updater) {
      store.setState((state) => {
        const current = select(state);
        const next = updater(current);
        return Object.is(next, current)
          ? state
          : { ...state, slices: { ...state.slices, [key]: next } };
      });
    }
  };
}

/** A part of a feature slice; re-renders only when that part changes (`isEqual`). */
export function useFeatureSlice<K extends FeatureSliceKey, T>(
  slice: FeatureSlice<K>,
  selector: (value: FeatureSlices[K]) => T,
  isEqual?: (left: T, right: T) => boolean
): T {
  const select = useCallback(
    (state: PlayerState) => selector(slice.select(state)),
    [slice, selector]
  );
  return usePlayerState(select, isEqual);
}

/** A stable updater bound to the player's store. */
export function useFeatureSliceUpdate<K extends FeatureSliceKey>(
  slice: FeatureSlice<K>
): (updater: (value: FeatureSlices[K]) => FeatureSlices[K]) => void {
  const { store } = useController();
  return useCallback((updater) => slice.update(store, updater), [slice, store]);
}
