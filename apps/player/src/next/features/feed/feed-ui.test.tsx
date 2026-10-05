/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPlainArchive } from "../../../../scripts/lib/synthetic-session.mjs";
import { createMediaUrlCache } from "../../../core/media-cache.js";
import { App } from "../../app.js";
import { createPlayerController } from "../../controller.js";
import { RAIL_TAB_REGISTRY } from "../registry.js";
import { createInitialState, type PlayerState } from "../../state.js";
import { createStore } from "../../store.js";

let archiveBytes: Uint8Array;

beforeAll(async () => {
  archiveBytes = await createPlainArchive();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.location.hash = "";
});

async function renderLoaded() {
  const store = createStore<PlayerState>(createInitialState("en", "system"));
  const controller = createPlayerController(store, {
    scheduler: { request: () => 0, cancel: () => undefined },
    mediaCache: createMediaUrlCache({ createUrl: () => "blob:frame", revokeUrl: () => undefined }),
    stepItems: (state) => {
      const stepItems = RAIL_TAB_REGISTRY.get(state.tab)?.stepItems;
      return state.archive && stepItems ? stepItems(state.archive, state) : null;
    }
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

const rowIds = () => screen.getAllByTestId("event-row").map((row) => row.dataset.eventId);

describe("problems strip", () => {
  it("lists grouped problems, first-party first, and walks through occurrences", async () => {
    const { store } = await renderLoaded();
    const strip = screen.getByTestId("problems-strip");
    const chips = within(strip).getAllByTestId("problem-chip");

    expect(within(strip).getByTestId("problems-count")).toHaveTextContent(
      `${chips.length} problems`
    );
    expect(chips[0]).toHaveTextContent(/^401 Unauthorized×\d+\/gw\/bff\/\*$/);
    expect(chips.at(-1)).toHaveAttribute("data-third-party", "true");
    expect(chips.at(-1)).toHaveTextContent("third-party");

    act(() => {
      fireEvent.click(chips[0] as HTMLElement);
    });
    const first = store.getState().selection;
    expect(chips[0]).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("live-region")).toHaveTextContent(/^401 Unauthorized: 1 of \d+, /);

    act(() => {
      fireEvent.click(chips[0] as HTMLElement);
    });
    expect(store.getState().selection).not.toEqual(first);
    expect(screen.getByTestId("live-region")).toHaveTextContent(/^401 Unauthorized: 2 of \d+, /);
  });
});

describe("activity feed filters", () => {
  it("hides third-party rows by default and brings them back from the hidden chip", async () => {
    await renderLoaded();
    const hideToggle = screen.getByTestId("feed-hide-third-party");
    expect(hideToggle).toHaveAttribute("aria-pressed", "true");
    const hiddenChip = screen.getByTestId("feed-hidden-count");
    expect(hiddenChip).toHaveTextContent(/^\d+ hidden$/);
    const before = rowIds().length;

    act(() => {
      fireEvent.click(hiddenChip);
    });
    expect(hideToggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("feed-hidden-count")).not.toBeInTheDocument();
    expect(rowIds().length).toBeGreaterThan(before);
    expect(
      screen.getAllByTestId("event-row").some((row) => row.dataset.thirdParty === "true")
    ).toBe(true);

    const toast = await screen.findByTestId("toast");
    expect(toast).toHaveTextContent("Third-party activity shown");
    act(() => {
      fireEvent.click(within(toast).getByTestId("toast-action"));
    });
    expect(hideToggle).toHaveAttribute("aria-pressed", "true");
  });

  it("narrows the feed to problems with Errors only", async () => {
    await renderLoaded();
    const before = rowIds().length;

    act(() => {
      fireEvent.click(screen.getByTestId("feed-errors-only"));
    });
    const rows = screen.getAllByTestId("event-row");
    expect(rows.length).toBeLessThan(before);
    expect(
      rows.every(
        (row) => row.className.includes("tone-error") || row.className.includes("is-action")
      )
    ).toBe(true);
  });

  it("opens a repeat group and steps into it with J / L", async () => {
    const { controller, store } = await renderLoaded();
    const toggle = screen.getAllByTestId("repeat-toggle")[0] as HTMLElement;
    const head = toggle.closest('[data-testid="event-row"]') as HTMLElement;
    const before = rowIds().length;

    act(() => {
      fireEvent.click(toggle);
    });
    expect(head).toHaveAttribute("aria-expanded", "true");
    expect(rowIds().length).toBeGreaterThan(before);

    act(() => {
      fireEvent.click(head);
    });
    act(() => {
      controller.stepList(1);
    });
    const nested = screen.getAllByTestId("event-row")[rowIds().indexOf(head.dataset.eventId) + 1];
    expect(store.getState().selection?.id).toBe(nested?.dataset.eventId);
    expect(nested?.className).toContain("nested");
  });
});
