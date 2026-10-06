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
import { useDocumentTheme } from "./use-document-theme.js";

type ArchiveBlob = { mime: string; bytes: Uint8Array };

let archiveBytes: Uint8Array;

beforeAll(async () => {
  archiveBytes = await createPlainArchive();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockObjectUrls() {
  const createObjectURL = vi.fn(() => "blob:trace");
  const revokeObjectURL = vi.fn();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  return { createObjectURL, revokeObjectURL };
}

async function renderPerf() {
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
  return { store, controller };
}

describe("Perf panel", () => {
  it("shows vitals at the playhead, long tasks and a downloadable trace", async () => {
    const { createObjectURL } = mockObjectUrls();
    const { store, controller } = await renderPerf();
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

  it("names the artifact controls and hands focus from Download to Save", async () => {
    mockObjectUrls();
    await renderPerf();
    const prepare = screen.getByTestId("perf-artifact-prepare");

    expect(prepare).toHaveAccessibleName(/^Download Trace at \d/u);
    prepare.focus();
    fireEvent.click(prepare);
    const save = await screen.findByTestId("perf-artifact-save");

    expect(save).toHaveAccessibleName(/^Save Trace at \d/u);
    expect(save).toHaveFocus();
  });

  it("revokes the object URL when the row goes away", async () => {
    const { revokeObjectURL } = mockObjectUrls();
    await renderPerf();
    fireEvent.click(screen.getByTestId("perf-artifact-prepare"));
    await screen.findByTestId("perf-artifact-save");

    cleanup();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:trace");
  });

  it("drops a download that resolves after the row unmounted", async () => {
    const { createObjectURL } = mockObjectUrls();
    const { store } = await renderPerf();
    const player = store.getState().archive?.player;
    let resolveBlob: (blob: ArchiveBlob | null) => void = () => undefined;
    vi.spyOn(player as NonNullable<typeof player>, "getBlob").mockReturnValue(
      new Promise((resolve) => {
        resolveBlob = resolve;
      })
    );
    const errors = vi.spyOn(console, "error");

    fireEvent.click(screen.getByTestId("perf-artifact-prepare"));
    cleanup();
    await act(async () => {
      resolveBlob({ bytes: new Uint8Array([123, 125]), mime: "application/json" });
    });

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it("follows the resolved theme on <html>, not the preference", async () => {
    const root = document.documentElement;
    root.dataset.theme = "light";
    function Probe() {
      return <span data-testid="theme">{useDocumentTheme()}</span>;
    }
    render(<Probe />);
    expect(screen.getByTestId("theme")).toHaveTextContent("light");

    // An OS flip under "system": only `data-theme` changes.
    await act(async () => {
      root.dataset.theme = "dark";
    });
    expect(screen.getByTestId("theme")).toHaveTextContent("dark");
    delete root.dataset.theme;
  });

  it("rates web vitals with the Core Web Vitals thresholds", () => {
    expect(rateVital("lcp", 2_400)).toBe("good");
    expect(rateVital("lcp", 3_000)).toBe("needs");
    expect(rateVital("lcp", 4_000)).toBe("poor");
    expect(rateVital("cls", 0.3)).toBe("poor");
  });
});
