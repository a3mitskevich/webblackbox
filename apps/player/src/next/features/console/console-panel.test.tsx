/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPlainArchive } from "../../../../scripts/lib/synthetic-session.mjs";
import { createMediaUrlCache } from "../../../core/media-cache.js";
import { App } from "../../app.js";
import { createPlayerController } from "../../controller.js";
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

async function renderConsole() {
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
  act(() => controller.setTab("console"));
  await screen.findByTestId("console-list");
  return { store, controller };
}

function rowByText(text: string): HTMLElement {
  const row = screen
    .getAllByTestId("console-row")
    .find((element) => element.textContent?.includes(text));

  if (!row) {
    throw new Error(`No console row with "${text}"`);
  }

  return row;
}

describe("Console panel", () => {
  it("lists rows with levels, hides third-party rows and counts errors in the tab", async () => {
    await renderConsole();

    expect(screen.getByTestId("tab-console").querySelector(".c.bad")).not.toBeNull();
    expect(screen.getAllByTestId("console-row").length).toBeGreaterThan(4);
    expect(screen.getByTestId("console-hidden-count")).toHaveTextContent("1 hidden");
    expect(screen.queryByText(/ERR_ADDRESS_INVALID/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("console-hide-third-party"));
    expect(screen.getByText(/ERR_ADDRESS_INVALID/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("console-level-warn"));
    expect(screen.getAllByTestId("console-row").every((row) => row.dataset.level === "warn")).toBe(
      true
    );
  });

  it("opens a logged error in place with its symbolicated stack and source", async () => {
    const { store } = await renderConsole();
    const row = screen
      .getAllByTestId("console-row")
      .filter((element) => element.textContent?.includes("AuthError"))
      .at(-1) as HTMLElement;

    fireEvent.click(row);

    expect(store.getState().selection).toEqual({ kind: "event", id: row.dataset.eventId });
    const details = await screen.findByTestId("console-details");
    // The status shows "Resolving…" first; symbolication finishes asynchronously.
    await waitFor(() =>
      expect(within(details).getByTestId("stack-status")).toHaveTextContent(
        "Symbolicated · embedded in archive"
      )
    );
    const frames = within(details).getAllByTestId("stack-frame");
    expect(frames[0]).toHaveTextContent("ensureCasinoUser");
    expect(frames[0]).toHaveTextContent("ensure-casino-user.ts:57:11");
    expect(within(details).getByTestId("stack-snippet")).toHaveTextContent("throw new AuthError");

    fireEvent.click(within(details).getByTestId("stack-mode-minified"));
    expect(within(details).getAllByTestId("stack-frame")[0]).toHaveTextContent(
      "/static/js/main.js:1:20412"
    );

    fireEvent.click(within(details).getByTestId("raw-event"));
    expect(within(details).getByTestId("raw-event-json")).toHaveTextContent(
      row.dataset.eventId ?? "-"
    );

    fireEvent.click(row);
    expect(screen.queryByTestId("console-details")).not.toBeInTheDocument();
  });

  it("moves with the arrow keys and keeps Enter of the opened row's buttons to them", async () => {
    const { store } = await renderConsole();
    const list = screen.getByTestId("console-list");
    const rows = screen.getAllByTestId("console-row");

    fireEvent.click(rows[0] as HTMLElement);
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(store.getState().selection).toEqual({ kind: "event", id: rows[1]?.dataset.eventId });
    expect(list).toHaveAttribute("aria-activedescendant", `console-${rows[1]?.dataset.eventId}`);
    expect(rows[1]).toHaveAttribute("aria-posinset", "2");
    expect(rows[1]).toHaveAttribute("aria-setsize", String(rows.length));
    expect(within(rows[1] as HTMLElement).getByRole("img")).toHaveAccessibleName();

    const errorRow = screen
      .getAllByTestId("console-row")
      .filter((element) => element.textContent?.includes("AuthError"))
      .at(-1) as HTMLElement;
    fireEvent.click(errorRow);
    const details = await screen.findByTestId("console-details");
    const rawButton = within(details).getByTestId("raw-event");

    fireEvent.keyDown(rawButton, { key: "Enter" });
    fireEvent.keyDown(rawButton, { key: "ArrowDown" });
    expect(screen.getByTestId("console-details")).toBeInTheDocument();
    expect(store.getState().selection).toEqual({ kind: "event", id: errorRow.dataset.eventId });
  });

  it("opens the request a resource error is about in the Network tab", async () => {
    const { store } = await renderConsole();

    fireEvent.click(screen.getByTestId("console-hide-third-party"));
    fireEvent.click(rowByText("ERR_ADDRESS_INVALID"));
    fireEvent.click(await screen.findByTestId("open-request"));

    expect(store.getState().tab).toBe("network");
    expect(store.getState().selection).toEqual({ kind: "request", id: "90080.1122" });
  });

  it("filters with the shared text filter and shows an empty state", async () => {
    const { controller } = await renderConsole();

    act(() => controller.setQuery("no such console text"));
    expect(screen.getByTestId("console-empty")).toHaveTextContent("No messages match the filters.");
  });
});
