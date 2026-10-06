/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createPlainArchive } from "../../../../scripts/lib/synthetic-session.mjs";
import { createMediaUrlCache } from "../../../core/media-cache.js";
import type { PlayerLocale } from "../../../lib/i18n.js";
import { App } from "../../app.js";
import { createPlayerController } from "../../controller.js";
import { createInitialState, type PlayerState } from "../../state.js";
import { createStore } from "../../store.js";

let archiveBytes: Uint8Array;
// jsdom has no scrollIntoView; one test installs a spy.
const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeAll(async () => {
  archiveBytes = await createPlainArchive();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.assign(Element.prototype, { scrollIntoView: originalScrollIntoView });
  window.localStorage.clear();
  window.location.hash = "";
});

async function renderTabs(locale: PlayerLocale = "en") {
  const store = createStore<PlayerState>(createInitialState(locale, "light"));
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
  act(() => controller.setTab("tabs"));
  await screen.findByTestId("tabs-panel");
  return { store, controller };
}

describe("Tabs panel", () => {
  it("shows the other tabs open at the playhead and seeks to a change", async () => {
    const { store, controller } = await renderTabs();
    const minMono = store.getState().archive?.model.minMono ?? 0;

    expect(screen.getByTestId("tabs-summary")).toHaveTextContent("2 other tabs seen");
    expect(screen.getAllByTestId("tabs-open-tab")).toHaveLength(2);
    expect(screen.getAllByTestId("tabs-open-tab")[0]).toHaveTextContent("Inbox");

    act(() => controller.seek(minMono + 15_000));
    expect(screen.getAllByTestId("tabs-open-tab")).toHaveLength(1);
    expect(screen.getByTestId("tabs-open")).toHaveTextContent("/users/7");

    const closed = screen
      .getAllByTestId("tabs-change")
      .find((row) => row.dataset.kind === "closed") as HTMLElement;
    fireEvent.click(closed);
    expect(store.getState().playheadMono).toBe(minMono + 14_000);
    expect(closed).toHaveAttribute("aria-selected", "true");
  });

  it("translates change kinds and snapshot reasons, keeping the raw value in data-kind", async () => {
    await renderTabs("ru");
    const rows = screen.getAllByTestId("tabs-change");
    const closed = rows.find((row) => row.dataset.kind === "closed") as HTMLElement;
    const snapshot = rows.find((row) => row.dataset.kind === "start") as HTMLElement;

    expect(closed.querySelector(".chg")).toHaveTextContent("закрыта");
    expect(closed.querySelector(".chg")).toHaveClass("chg-closed");
    expect(snapshot.querySelector(".chg")).toHaveTextContent("снимок · начало записи");
    expect(screen.getByTestId("tabs-log")).not.toHaveTextContent(/closed|navigated|start/u);
  });

  it("steps through the changes with the keyboard and keeps the row in view", async () => {
    const scrollIntoView = vi.fn();
    Object.assign(Element.prototype, { scrollIntoView });
    const { store, controller } = await renderTabs();
    const list = screen.getByTestId("tabs-log");
    const rows = screen.getAllByTestId("tabs-change");
    const first = rows[0] as HTMLElement;
    const second = rows[1] as HTMLElement;
    const last = rows.at(-1) as HTMLElement;

    expect(list).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(list).toHaveAttribute("aria-activedescendant", first.id);

    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(list).toHaveAttribute("aria-activedescendant", second.id);
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(second);

    fireEvent.keyDown(list, { key: "End" });
    expect(last).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(list, { key: "Home" });
    expect(first).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(first).toHaveAttribute("aria-selected", "true");

    const firstMono = store.getState().playheadMono;
    act(() => controller.seek(store.getState().archive?.model.maxMono ?? 0));
    fireEvent.keyDown(list, { key: "Enter" });
    expect(store.getState().playheadMono).toBe(firstMono);

    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(first).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(list, { key: "End", ctrlKey: true });
    fireEvent.keyDown(list, { key: "ArrowDown", altKey: true });
    expect(first).toHaveAttribute("aria-selected", "true");
  });
});
