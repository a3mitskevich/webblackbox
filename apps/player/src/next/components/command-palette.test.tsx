/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPlainArchive } from "../../../scripts/lib/synthetic-session.mjs";
import { createMediaUrlCache } from "../../core/media-cache.js";
import { App } from "../app.js";
import { createPlayerController } from "../controller.js";
import { generateSlice } from "../features/generate/api.js";
import { createInitialState, type PlayerState } from "../state.js";
import { createStore } from "../store.js";

let archiveBytes: Uint8Array;

beforeAll(async () => {
  archiveBytes = await createPlainArchive();
});

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

async function renderPlayer() {
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
  return { store, controller };
}

function ctrlK(): void {
  fireEvent.keyDown(document.body, { key: "k", code: "KeyK", ctrlKey: true });
}

describe("Command palette", () => {
  it("opens with Ctrl+K, runs a command and closes", async () => {
    const { store } = await renderPlayer();

    act(() => ctrlK());
    const palette = await screen.findByTestId("command-palette");
    const input = within(palette).getByTestId("palette-input");
    fireEvent.change(input, { target: { value: "playwright mocks" } });

    const item = await within(palette).findByText(/Playwright test with mocks/);
    fireEvent.click(item);
    expect(screen.queryByTestId("command-palette")).not.toBeInTheDocument();
    expect(generateSlice.select(store.getState()).request?.kind).toBe("playwright-mocks");
  });

  it("runs the highlighted command with ArrowDown and Enter", async () => {
    const { store, controller } = await renderPlayer();

    act(() => controller.setPaletteOpen(true));
    const palette = await screen.findByTestId("command-palette");
    const input = within(palette).getByTestId("palette-input");
    // The first command is highlighted on open; ArrowDown moves to the second one.
    const [, second] = await within(palette).findAllByTestId("palette-item");
    expect(second).toHaveTextContent("Playwright test with mocks…");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() => expect(second).toHaveAttribute("data-highlighted"));
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.queryByTestId("command-palette")).not.toBeInTheDocument());
    expect(generateSlice.select(store.getState()).request?.kind).toBe("playwright-mocks");
  });

  it("offers to collapse the lanes once they are expanded", async () => {
    const { store, controller } = await renderPlayer();

    act(() => controller.setLanesExpanded(true));
    act(() => controller.setPaletteOpen(true));
    const palette = await screen.findByTestId("command-palette");
    fireEvent.change(within(palette).getByTestId("palette-input"), {
      target: { value: "lanes" }
    });
    const item = await within(palette).findByText("Collapse lanes");
    expect(within(palette).queryByText("Expand lanes")).not.toBeInTheDocument();
    fireEvent.click(item);
    expect(store.getState().lanesExpanded).toBe(false);
  });

  it("finds requests by URL and opens them in the Network tab", async () => {
    const { store, controller } = await renderPlayer();

    act(() => controller.setPaletteOpen(true));
    const palette = await screen.findByTestId("command-palette");
    fireEvent.change(within(palette).getByTestId("palette-input"), {
      target: { value: "casino-user" }
    });

    const items = await within(palette).findAllByTestId("palette-item");
    const request = items.find((item) => item.dataset.itemId === "req-90080.1706");
    expect(request).toHaveTextContent(/401 GET .*casino-user/);
    fireEvent.click(request as HTMLElement);
    expect(store.getState().tab).toBe("network");
    expect(store.getState().selection).toEqual({ kind: "request", id: "90080.1706" });
  });

  it("opens an event found by its id in the inspector", async () => {
    const { store, controller } = await renderPlayer();
    const event = store.getState().archive?.model.events[12];

    act(() => controller.setPaletteOpen(true));
    const palette = await screen.findByTestId("command-palette");
    fireEvent.change(within(palette).getByTestId("palette-input"), {
      target: { value: event?.id ?? "" }
    });

    const items = await within(palette).findAllByTestId("palette-item");
    const first = items.find((item) => item.dataset.itemId === `evt-${event?.id}`);
    expect(first).toBeDefined();
    fireEvent.click(first as HTMLElement);
    expect(store.getState()).toMatchObject({
      tab: "activity",
      detailsOpen: true,
      selection: { kind: "event", id: event?.id }
    });
  });
});
