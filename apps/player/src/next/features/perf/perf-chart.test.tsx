/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PROPS = {
  offsets: [0, 1, 2],
  series: [{ label: "Requests", colorToken: "--accent", values: [1, 3, 2] }],
  height: 100,
  playhead: 1,
  onSeek: () => undefined,
  label: "Network",
  timeLabel: "Time",
  summary: "Peak 3 requests in flight",
  unavailableText: "The chart could not be drawn.",
  themeKey: "light-en",
  testId: "chart"
};

/** A fresh chart module (its canvas-support cache too) with `uplot` replaced by `factory`. */
type ModuleFactory = () => Record<string, unknown> | Promise<Record<string, unknown>>;

async function loadChart(factory: ModuleFactory) {
  vi.resetModules();
  vi.doMock("uplot", factory);
  return import("./perf-chart.js");
}

beforeEach(() => {
  // The chart only mounts uPlot where a 2D canvas exists (not in plain jsdom).
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 test");
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as CanvasRenderingContext2D
  );
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.doUnmock("uplot");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PerfChart", () => {
  it("describes the canvas with a text summary", async () => {
    const { PerfChart } = await loadChart(() => new Promise<never>(() => undefined));
    render(<PerfChart {...PROPS} />);
    const figure = screen.getByTestId("chart");

    expect(figure).toHaveAccessibleName("Network");
    expect(figure).toHaveAccessibleDescription("Peak 3 requests in flight");
  });

  it("says the chart is unavailable when uPlot fails to load", async () => {
    const { PerfChart } = await loadChart(() => {
      throw new Error("chunk failed");
    });
    render(<PerfChart {...PROPS} />);

    expect(await screen.findByTestId("chart-unavailable")).toHaveTextContent(
      "The chart could not be drawn."
    );
    expect(console.error).toHaveBeenCalled();
  });

  it("says the chart is unavailable when uPlot fails to draw", async () => {
    const { PerfChart } = await loadChart(() => ({
      default: class {
        static paths = {};
        constructor() {
          throw new Error("no canvas");
        }
      }
    }));
    render(<PerfChart {...PROPS} />);

    expect(await screen.findByTestId("chart-unavailable")).toBeInTheDocument();
    expect(screen.getByTestId("chart")).toHaveAttribute("data-unavailable", "true");
  });

  it("draws again on the next redraw after a failed draw", async () => {
    let shouldFail = true;
    const { PerfChart } = await loadChart(() => ({
      default: class {
        static paths = {};
        constructor() {
          if (shouldFail) {
            throw new Error("no canvas");
          }
        }
        over = document.createElement("div");
        cursor = {};
        setSize() {}
        destroy() {}
      }
    }));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      }
    );
    const { rerender } = render(<PerfChart {...PROPS} />);
    expect(await screen.findByTestId("chart-unavailable")).toBeInTheDocument();

    shouldFail = false;
    rerender(<PerfChart {...PROPS} themeKey="dark-en" />);

    await waitFor(() => expect(screen.queryByTestId("chart-unavailable")).not.toBeInTheDocument());
    expect(screen.getByTestId("chart")).not.toHaveAttribute("data-unavailable");
  });
});
