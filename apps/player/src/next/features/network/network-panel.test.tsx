/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPlainArchive } from "../../../../scripts/lib/synthetic-session.mjs";
import { createMediaUrlCache } from "../../../core/media-cache.js";
import { App } from "../../app.js";
import { PlayerProvider } from "../../context.js";
import { createPlayerController } from "../../controller.js";
import { createInitialState, type PlayerState } from "../../state.js";
import { createStore } from "../../store.js";
import { CodeView, MAX_AUTO_HIGHLIGHT_CHARS } from "./code-view.js";

let archiveBytes: Uint8Array;

beforeAll(async () => {
  archiveBytes = await createPlainArchive();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.location.hash = "";
});

function createController() {
  const store = createStore<PlayerState>(createInitialState("en", "light"));
  const controller = createPlayerController(store, {
    scheduler: { request: () => 0, cancel: () => undefined },
    mediaCache: createMediaUrlCache({ createUrl: () => "blob:frame", revokeUrl: () => undefined })
  });
  return { store, controller };
}

async function renderLoaded() {
  const { store, controller } = createController();
  render(<App controller={controller} />);
  await act(async () => {
    await controller.openFile({
      name: "synthetic.webblackbox",
      arrayBuffer: async () => archiveBytes.slice().buffer
    });
  });
  act(() => controller.setTab("network"));
  await screen.findByTestId("network-table");
  return { store, controller };
}

describe("Network tab", () => {
  it("lists requests and sockets with chip counts; third parties hidden by default", async () => {
    await renderLoaded();

    const rows = screen.getAllByTestId("request-row");
    expect(rows.some((row) => row.dataset.kind === "socket")).toBe(true);
    expect(rows.some((row) => row.textContent?.includes("tracker.example.net"))).toBe(false);
    expect(screen.getByTestId("net-type-ws")).toHaveTextContent("2");
    expect(screen.getByTestId("net-hide-third-party")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("net-hidden-count")).toHaveTextContent("hidden");

    fireEvent.click(screen.getByTestId("net-type-ws"));
    const sockets = screen.getAllByTestId("request-row");
    expect(sockets.every((row) => row.dataset.kind === "socket")).toBe(true);
  });

  it("shows why a body was not captured, in the details and as a row marker", async () => {
    const { controller } = await renderLoaded();

    act(() => {
      controller.select({ kind: "request", id: "90080.1400" });
      controller.openDetails();
    });
    const details = await screen.findByTestId("request-details");
    fireEvent.click(within(details).getByTestId("detail-tab-response"));

    const note = await screen.findByTestId("response-body-note");
    expect(note).toHaveAttribute("data-reason", "too-large");
    expect(note).toHaveTextContent("Not captured — too large (5.00 MB, limit 1.00 MB)");
    const row = screen
      .getAllByTestId("request-row")
      .find((item) => item.dataset.rowId === "90080.1400");
    expect(row && within(row).getByTestId("row-not-captured")).toBeTruthy();
  });

  it("hides a socket's token and gives the rail the whole width with F", async () => {
    const { store, controller } = await renderLoaded();
    const open = store
      .getState()
      .archive?.model.events.find((event) => event.type === "network.ws.open");

    act(() => {
      controller.select({ kind: "event", id: open?.id ?? "" });
      controller.openDetails();
    });
    const details = await screen.findByTestId("socket-details");
    expect(within(details).getByTestId("hidden-params")).toHaveTextContent("access_token");
    expect(within(details).getByTestId("details-url")).not.toHaveTextContent("eyJ");

    (document.activeElement as HTMLElement | null)?.blur();
    act(() => {
      fireEvent.keyDown(document.body, { key: "f", code: "KeyF" });
    });
    expect(store.getState().railWide).toBe(true);
    expect(screen.getByTestId("workspace")).toHaveClass("body-rail-wide");
  });

  it("reads one connection as a conversation in the Realtime tab", async () => {
    const { controller } = await renderLoaded();

    act(() => controller.setTab("realtime"));
    await screen.findByTestId("conversation");
    const messages = screen.getAllByTestId("conversation-message");
    expect(messages.length).toBeGreaterThan(0);

    fireEvent.click(messages[0] as HTMLElement);
    expect(await screen.findByTestId("message-view")).toBeInTheDocument();
  });

  it("moves the selected request with the arrow keys and points the grid at it", async () => {
    await renderLoaded();
    const grid = screen.getByTestId("network-table");
    const selectedRow = () =>
      screen
        .getAllByTestId("request-row")
        .find((row) => row.getAttribute("aria-selected") === "true");

    expect(grid).toHaveAttribute("tabindex", "0");
    expect(selectedRow()).toBeUndefined();

    grid.focus();
    act(() => {
      fireEvent.keyDown(grid, { key: "ArrowDown" });
    });
    const rows = screen.getAllByTestId("request-row");
    expect(rows[0]).toHaveAttribute("aria-selected", "true");

    act(() => {
      fireEvent.keyDown(grid, { key: "ArrowDown" });
    });
    const second = selectedRow();
    expect(second?.dataset.rowId).toBe(rows[1]?.dataset.rowId);
    expect(grid).toHaveAttribute("aria-activedescendant", second?.id);
    // Ids are unique even when row ids differ only in characters an id cannot hold.
    const ids = screen.getAllByTestId("request-row").map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);

    act(() => {
      fireEvent.keyDown(grid, { key: "Home" });
    });
    expect(selectedRow()?.dataset.rowId).toBe(rows[0]?.dataset.rowId);
  });

  it("moves the selected message of a conversation with the arrow keys", async () => {
    const { controller } = await renderLoaded();

    act(() => controller.setTab("realtime"));
    const conversation = await screen.findByTestId("conversation");
    expect(conversation).toHaveAttribute("tabindex", "0");

    act(() => {
      fireEvent.keyDown(conversation, { key: "ArrowDown" });
    });
    const messages = screen.getAllByTestId("conversation-message");
    expect(messages[0]).toHaveAttribute("aria-selected", "true");

    act(() => {
      fireEvent.keyDown(conversation, { key: "ArrowDown" });
    });
    const selected = screen
      .getAllByTestId("conversation-message")
      .find((message) => message.getAttribute("aria-selected") === "true");
    expect(selected?.dataset.eventId).toBe(messages[1]?.dataset.eventId);
    expect(conversation).toHaveAttribute("aria-activedescendant", selected?.id);
  });

  it("makes a scrolling body a focusable, named region", async () => {
    const { store, controller } = await renderLoaded();
    const request = store
      .getState()
      .archive?.model.waterfall.find((entry) => entry.url.includes("casino-user"));

    act(() => {
      controller.select({ kind: "request", id: request?.reqId ?? "" });
      controller.openDetails();
    });
    const details = await screen.findByTestId("request-details");
    fireEvent.click(within(details).getByTestId("detail-tab-response"));
    fireEvent.click(await screen.findByTestId("body-view-raw"));

    const region = within(screen.getByTestId("response-body-raw")).getByRole("region", {
      name: "Code"
    });
    expect(region).toHaveAttribute("tabindex", "0");
  });
});

describe("CodeView", () => {
  it("forgets a forced highlight when the text changes", () => {
    const { controller } = createController();
    const big = (fill: string) => `[${`"${fill}",`.repeat(MAX_AUTO_HIGHLIGHT_CHARS / 4)}0]`;
    const { rerender } = render(
      <PlayerProvider controller={controller}>
        <CodeView text={big("a")} language="json" />
      </PlayerProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Highlight" }));
    expect(screen.queryByRole("button", { name: "Highlight" })).toBeNull();

    rerender(
      <PlayerProvider controller={controller}>
        <CodeView text={big("b")} language="json" />
      </PlayerProvider>
    );
    expect(screen.getByRole("button", { name: "Highlight" })).toBeInTheDocument();
  });
});
