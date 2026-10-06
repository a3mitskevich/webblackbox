/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createPlainArchive } from "../../../scripts/lib/synthetic-session.mjs";
import * as format from "../../core/format.js";
import { createMediaUrlCache } from "../../core/media-cache.js";
import { App } from "../app.js";
import { createPlayerController } from "../controller.js";
import { createInitialState, type PlayerState } from "../state.js";
import { createStore } from "../store.js";

vi.mock("../../core/format.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/format.js")>();
  return { ...actual, formatRulerSeconds: vi.fn(actual.formatRulerSeconds) };
});

let archiveBytes: Uint8Array;

beforeAll(async () => {
  archiveBytes = await createPlainArchive();
});

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

describe("Timeline", () => {
  it("does not re-render the static lanes when only the playhead moves", async () => {
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

    const rulerCalls = vi.mocked(format.formatRulerSeconds).mock.calls.length;
    const minMono = store.getState().archive?.model.minMono ?? 0;
    expect(rulerCalls).toBeGreaterThan(0);

    act(() => {
      for (let step = 1; step <= 5; step += 1) {
        store.setState((state) => ({ ...state, playheadMono: minMono + step * 1_000 }));
      }
    });

    expect(screen.getByTestId("scrubber")).toHaveAttribute("aria-valuenow", "5");
    expect(vi.mocked(format.formatRulerSeconds).mock.calls.length).toBe(rulerCalls);

    const marks = screen.getAllByTestId("action-mark");
    act(() => (marks[1] as HTMLElement).click());
    expect(screen.getAllByTestId("action-mark")[1]).toHaveClass("cur");

    act(() => controller.setLocale("ru"));
    expect(vi.mocked(format.formatRulerSeconds).mock.calls.length).toBeGreaterThan(rulerCalls);
  });

  it("shows the range with a clear button and expands every lane", async () => {
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
    const minMono = store.getState().archive?.model.minMono ?? 0;

    expect(screen.queryByTestId("timeline-range")).not.toBeInTheDocument();
    act(() => {
      controller.seek(minMono + 2_000);
      controller.markRange("start");
      controller.seek(minMono + 5_000);
      controller.markRange("end");
    });
    expect(screen.getByTestId("range-chip")).toHaveTextContent("Range 0:02.00 – 0:05.00");
    expect(screen.getByTestId("timeline-range")).toBeInTheDocument();
    expect(screen.getByTestId("live-region")).toHaveTextContent("Range 0:02.00 – 0:05.00 selected");
    act(() => screen.getByTestId("range-clear").click());
    expect(store.getState().range).toBeNull();
    expect(screen.queryByTestId("range-chip")).not.toBeInTheDocument();

    expect(screen.queryByTestId("lane-console")).not.toBeInTheDocument();
    act(() => screen.getByTestId("expand-lanes").click());
    expect(screen.getByTestId("expand-lanes")).toHaveAttribute("aria-pressed", "true");
    for (const lane of ["navigation", "console", "storage", "pointer", "filmstrip", "tabs"]) {
      expect(screen.getByTestId(`lane-${lane}`)).toBeInTheDocument();
    }

    const frame = screen.getAllByTestId("filmstrip-frame")[0] as HTMLElement;
    expect(frame).toHaveAccessibleName(/^Screenshot at /);
    act(() => frame.click());
    expect(store.getState().selection?.kind).toBe("event");
  });
});
