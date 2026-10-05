/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createPlainArchive } from "../../../../scripts/lib/synthetic-session.mjs";
import { createMediaUrlCache } from "../../../core/media-cache.js";
import { App } from "../../app.js";
import { createPlayerController } from "../../controller.js";
import { createInitialState, type PlayerState } from "../../state.js";
import { createStore } from "../../store.js";
import { rateVital } from "./perf-panel.js";

let archiveBytes: Uint8Array;

beforeAll(async () => {
  archiveBytes = await createPlainArchive();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Perf panel", () => {
  it("shows vitals at the playhead, long tasks and a downloadable trace", async () => {
    const createObjectURL = vi.fn(() => "blob:trace");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const store = createStore<PlayerState>(createInitialState("en", "light"));
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
    act(() => controller.setTab("perf"));
    await screen.findByTestId("perf-panel");
    const minMono = store.getState().archive?.model.minMono ?? 0;

    expect(screen.getByTestId("perf-vital-lcp")).toHaveAttribute("data-rating", "none");
    act(() => controller.seek(minMono + 12_000));
    expect(screen.getByTestId("perf-vital-lcp")).toHaveTextContent("2,480");
    expect(screen.getByTestId("perf-vital-lcp")).toHaveAttribute("data-rating", "good");
    expect(screen.getByTestId("perf-vital-cls")).toHaveAttribute("data-rating", "needs");
    expect(screen.getByTestId("perf-vital-inp")).toHaveAttribute("data-rating", "needs");
    expect(screen.getByTestId("perf-long-tasks")).toHaveTextContent("3 long tasks, 515ms in total");
    expect(screen.getByTestId("perf-chart-network")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("perf-artifact-prepare"));
    const save = await screen.findByTestId("perf-artifact-save");
    expect(save).toHaveAttribute("href", "blob:trace");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("rates web vitals with the Core Web Vitals thresholds", () => {
    expect(rateVital("lcp", 2_400)).toBe("good");
    expect(rateVital("lcp", 3_000)).toBe("needs");
    expect(rateVital("lcp", 4_000)).toBe("poor");
    expect(rateVital("cls", 0.3)).toBe("poor");
  });
});
