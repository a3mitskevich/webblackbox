/* @vitest-environment jsdom */

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { act, cleanup, render } from "@testing-library/react";
import { afterAll, expect, it } from "vitest";

import { createMediaUrlCache } from "../../src/core/media-cache.js";
import { RAIL_TABS, type RailTab } from "../../src/core/url-hash.js";
import { App } from "../../src/next/app.js";
import { createPlayerController } from "../../src/next/controller.js";
import { createInitialState, type PlayerState } from "../../src/next/state.js";
import { createStore } from "../../src/next/store.js";
import {
  buildLongSyntheticSession,
  createLongPlainArchive,
  LONG_SESSION_DEFAULTS
} from "../lib/synthetic-long-session.mjs";

/** Lists follow the playhead in 120 ms buckets while playing (`NOW_BUCKET_MS`). */
const TICK_MS = 120;

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function percentile(samples: readonly number[], ratio: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(ratio * sorted.length))] ?? 0;
}

/**
 * jsdom lays nothing out: every element is 0 × 0, so a measured virtual list keeps mounting rows
 * (all of them "fit") until React gives up. TanStack Virtual sizes the scroll box and measures rows
 * through offsetWidth / offsetHeight: give rows (`data-index`) a row height and everything else a
 * panel-sized box, so the lists window their rows like they do in Chrome.
 */
const ROW_HEIGHT = 32;
const BOX = { width: 640, height: 600 };
const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");

Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement) {
    return this.hasAttribute("data-index") ? ROW_HEIGHT : BOX.height;
  }
});
Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get: () => BOX.width
});

afterAll(() => {
  cleanup();

  if (offsetHeight && offsetWidth) {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight);
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidth);
  }
});

/**
 * Renders the whole React player in jsdom with the long archive open, then, for every rail tab,
 * moves the playhead tick by tick while "playing" and times the synchronous React update (render +
 * commit). jsdom has no layout, so this measures React work, not paint.
 */
it("re-renders the player per playhead tick on a long recording", async () => {
  const events = readPositiveInt("BENCH_PLAYER_EVENTS", LONG_SESSION_DEFAULTS.events);
  const durationMs = readPositiveInt("BENCH_PLAYER_DURATION_MS", LONG_SESSION_DEFAULTS.durationMs);
  const ticksPerTab = readPositiveInt("BENCH_PLAYER_RENDER_TICKS", 120);
  const bytes = await createLongPlainArchive(buildLongSyntheticSession({ events, durationMs }));
  const store = createStore<PlayerState>(createInitialState("en", "system"));
  const controller = createPlayerController(store, {
    scheduler: { request: () => 0, cancel: () => undefined },
    mediaCache: createMediaUrlCache({ createUrl: () => "blob:frame", revokeUrl: () => undefined })
  });

  render(<App controller={controller} />);

  const openStart = performance.now();
  await act(async () => {
    await controller.openFile({
      name: "long.webblackbox",
      arrayBuffer: async () => bytes.slice().buffer
    });
  });
  const openRenderMs = performance.now() - openStart;
  const archive = store.getState().archive;
  expect(archive).not.toBeNull();

  const { minMono, durationMono } = archive?.model ?? { minMono: 0, durationMono: 0 };
  const tabs: Record<string, { firstRenderMs: number; tickP50: number; tickP95: number }> = {};
  const allTicks: number[] = [];
  const failedPanels = new Set<string>();
  const noteFailures = (): void => {
    for (const node of document.querySelectorAll("[data-testid='panel-failed']")) {
      const panel = node.closest("[data-testid^='panel-']:not([data-testid='panel-failed'])");
      failedPanels.add(panel?.getAttribute("data-testid") ?? node.parentElement?.className ?? "?");
    }
  };

  noteFailures();

  for (const tab of RAIL_TABS.filter((id): id is RailTab => id !== "compare")) {
    const tabStart = performance.now();
    act(() => store.setState((state) => ({ ...state, tab, isPlaying: true })));
    const firstRenderMs = performance.now() - tabStart;
    const samples: number[] = [];
    // Spread over the session: pairs of consecutive 120 ms steps from evenly spaced points.
    const step = durationMono / ticksPerTab;

    for (let index = 0; index < ticksPerTab; index += 1) {
      const playheadMono = minMono + Math.floor(index / 2) * 2 * step + (index % 2) * TICK_MS;
      const start = performance.now();
      act(() => store.setState((state) => ({ ...state, playheadMono })));
      samples.push(performance.now() - start);
    }

    noteFailures();
    allTicks.push(...samples);
    tabs[tab] = {
      firstRenderMs,
      tickP50: percentile(samples, 0.5),
      tickP95: percentile(samples, 0.95)
    };
  }

  const report = {
    openRenderMs,
    ticks: allTicks.length,
    tickP50: percentile(allTicks, 0.5),
    tickP95: percentile(allTicks, 0.95),
    failedPanels: [...failedPanels],
    tabs
  };
  const reportPath = process.env.BENCH_RENDER_REPORT;

  if (reportPath) {
    writeFileSync(reportPath, JSON.stringify(report));
  } else {
    console.info(JSON.stringify(report, null, 2));
  }

  // A panel that crashed rendered its fallback instead: its timings mean nothing.
  expect(report.failedPanels).toEqual([]);
});
