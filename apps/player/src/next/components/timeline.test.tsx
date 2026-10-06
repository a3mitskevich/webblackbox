/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createPlainArchive } from "../../../scripts/lib/synthetic-session.mjs";
import * as format from "../../core/format.js";
import { createMediaUrlCache } from "../../core/media-cache.js";
import { createPlayerI18n } from "../../lib/i18n.js";
import type { PointerLaneKind } from "../../lib/pointer-overlay.js";
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

async function openedApp() {
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
  return { store, controller };
}

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

  it("gives each expanded lane one tab stop, moved by the arrow keys", async () => {
    const { store, controller } = await openedApp();
    act(() => screen.getByTestId("expand-lanes").click());
    const playhead = store.getState().playheadMono;

    const marks = screen.getAllByTestId("pointer-mark");
    expect(marks.length).toBeGreaterThan(1);
    expect(marks.filter((mark) => mark.tabIndex === 0)).toEqual([marks[0]]);
    expect(screen.getByTestId("lane-pointer")).toHaveAttribute("role", "toolbar");

    act(() => (marks[0] as HTMLElement).focus());
    act(() => {
      fireEvent.keyDown(marks[0] as HTMLElement, { key: "ArrowRight", code: "ArrowRight" });
    });
    expect(document.activeElement).toBe(marks[1]);
    // On a lane the arrows move between marks; they do not seek.
    expect(store.getState().playheadMono).toBe(playhead);
    expect((marks[1] as HTMLElement).tabIndex).toBe(0);
    expect((marks[0] as HTMLElement).tabIndex).toBe(-1);
    act(() => {
      fireEvent.keyDown(marks[1] as HTMLElement, { key: "End" });
    });
    expect(document.activeElement).toBe(marks[marks.length - 1]);

    // The marks are named in the current locale, not the one the archive was opened in.
    const kind = (marks[0] as HTMLElement).dataset.kind as PointerLaneKind;
    act(() => controller.setLocale("ru"));
    expect(screen.getAllByTestId("pointer-mark")[0]).toHaveAccessibleName(
      new RegExp(createPlayerI18n("ru").formatPointerKind(kind))
    );
  });

  it("keeps ← / → as seek keys on other toolbars (the Console filter chips)", async () => {
    const { store, controller } = await openedApp();
    act(() => controller.setTab("console"));
    const toolbar = await screen.findByRole(
      "toolbar",
      { name: "Console filters" },
      { timeout: 5_000 }
    );
    const chip = within(toolbar).getAllByRole("button")[0] as HTMLElement;
    const before = store.getState().playheadMono;

    act(() => chip.focus());
    act(() => {
      fireEvent.keyDown(chip, { key: "ArrowRight", code: "ArrowRight" });
    });
    expect(store.getState().playheadMono).toBeGreaterThan(before);
  });
});
