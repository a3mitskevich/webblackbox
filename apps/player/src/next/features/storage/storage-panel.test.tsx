/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPlainArchive } from "../../../../scripts/lib/synthetic-session.mjs";
import { createMediaUrlCache } from "../../../core/media-cache.js";
import { App } from "../../app.js";
import { createPlayerController } from "../../controller.js";
import { createInitialState, type PlayerState } from "../../state.js";
import { createStore } from "../../store.js";
import { loadSyntheticArchive } from "../test-archive.js";
import {
  capTitle,
  filterStorageChanges,
  matchesQuery,
  MAX_SEARCH_VALUE_CHARS,
  MAX_TITLE_CHARS,
  selectStorageData
} from "./storage-model.js";
import { diffJsonValues } from "./value-diff.js";

let archiveBytes: Uint8Array;

beforeAll(async () => {
  archiveBytes = await createPlainArchive();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.location.hash = "";
});

async function renderStorage() {
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
  act(() => controller.setTab("storage"));
  await screen.findByTestId("storage-state");
  return { store, controller };
}

describe("Storage panel", () => {
  it("shows localStorage at the playhead and follows it", async () => {
    const { controller, store } = await renderStorage();
    const minMono = store.getState().archive?.model.minMono ?? 0;
    const keys = () =>
      screen.queryAllByTestId("storage-item").map((row) => row.querySelector(".key")?.textContent);

    act(() => controller.seek(minMono + 1_000));
    expect(keys()).toEqual(["clientId", "lang"]);
    expect(screen.getByTestId("storage-coverage")).toHaveTextContent("From the snapshot at");

    act(() => controller.seek(minMono + 12_000));
    expect(keys()).toEqual(["clientId", "lang", "lobbyState"]);
    expect(screen.getAllByTestId("storage-item")[2]).toHaveTextContent('"open":64');

    act(() => controller.seek(minMono + 15_000));
    expect(keys()).toEqual(["lang", "lobbyState"]);
  });

  it("lists cookies with their flags and IndexedDB records", async () => {
    const { controller, store } = await renderStorage();
    act(() => controller.seek((store.getState().archive?.model.minMono ?? 0) + 1_000));

    fireEvent.click(screen.getByTestId("storage-area-cookie"));
    const cookies = screen.getAllByTestId("storage-cookie");
    expect(cookies[0]).toHaveTextContent("session");
    expect(cookies[0]).toHaveTextContent("HttpOnly");
    expect(cookies[0]).toHaveTextContent("SameSite=Lax");

    fireEvent.click(screen.getByTestId("storage-area-idb"));
    expect(screen.getByTestId("storage-idb")).toHaveTextContent("game-cache");
    expect(screen.getAllByTestId("storage-idb-record")[0]).toHaveTextContent("Live table 64");

    fireEvent.click(screen.getByTestId("storage-area-session"));
    expect(screen.getByTestId("storage-coverage")).toHaveTextContent("Recorded later, first at");
    fireEvent.click(screen.getByTestId("storage-first-record"));
    expect(screen.getByTestId("storage-coverage")).toHaveTextContent("No snapshot");
    expect(screen.getAllByTestId("storage-item")[0]).toHaveTextContent("#/error");
  });

  it("opens a write from the log with its old → new field changes", async () => {
    const { store } = await renderStorage();

    fireEvent.click(screen.getByTestId("storage-view-log"));
    const writes = screen
      .getAllByTestId("storage-change")
      .filter((row) => row.textContent?.includes("lobbyState"));
    fireEvent.click(writes[1] as HTMLElement);

    expect(store.getState().selection?.kind).toBe("event");
    const details = screen.getByTestId("storage-change-details");
    const fields = within(details).getByTestId("storage-field-changes");
    expect(fields).toHaveTextContent("v");
    expect(fields).toHaveTextContent("1 → 2");
    expect(fields).toHaveTextContent("+ 64");

    const firstSession = screen
      .getAllByTestId("storage-change")
      .find((row) => row.dataset.area === "session");
    fireEvent.click(firstSession as HTMLElement);
    expect(screen.getByTestId("storage-change-details")).toHaveTextContent(
      "The value before this write is not in the recording."
    );
  });
});

describe("Storage log keyboard", () => {
  it("steps through the log with the arrows, Home, End and Enter like a click", async () => {
    const { store, controller } = await renderStorage();
    fireEvent.click(screen.getByTestId("storage-view-log"));
    const list = screen.getByTestId("storage-log");
    const rows = () => screen.getAllByTestId("storage-change");
    const selectedRow = () => rows().find((row) => row.getAttribute("aria-selected") === "true");

    expect(list).toHaveAttribute("role", "listbox");
    expect(list).toHaveAttribute("tabindex", "0");
    expect(list).not.toHaveAttribute("aria-activedescendant");

    fireEvent.keyDown(list, { key: "ArrowDown" });
    const first = rows()[0] as HTMLElement;
    expect(selectedRow()).toBe(first);
    expect(first.id).toMatch(/^storage-change-/u);
    expect(list).toHaveAttribute("aria-activedescendant", first.id);
    expect(screen.getByTestId("storage-change-details")).toBeInTheDocument();

    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(selectedRow()).toBe(rows()[1]);
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(selectedRow()).toBe(rows()[0]);
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(selectedRow()).toBe(rows()[0]);

    fireEvent.keyDown(list, { key: "End" });
    const last = rows().at(-1) as HTMLElement;
    expect(selectedRow()).toBe(last);
    expect(list).toHaveAttribute("aria-activedescendant", last.id);
    const lastMono = store.getState().playheadMono;

    act(() => controller.seek(store.getState().archive?.model.minMono ?? 0));
    fireEvent.keyDown(list, { key: "Enter" });
    expect(store.getState().playheadMono).toBe(lastMono);

    fireEvent.keyDown(list, { key: "Home" });
    expect(selectedRow()).toBe(rows()[0]);
  });

  it("leaves keys typed inside the list to their target", async () => {
    const { store } = await renderStorage();
    fireEvent.click(screen.getByTestId("storage-view-log"));
    const row = screen.getAllByTestId("storage-change")[0] as HTMLElement;

    fireEvent.keyDown(row, { key: "ArrowDown" });
    expect(store.getState().selection).toBeNull();
  });
});

describe("storage model", () => {
  it("filters the log and key rows by text", async () => {
    const archive = await loadSyntheticArchive();
    const { changes } = selectStorageData(archive);

    expect(selectStorageData(archive).changes).toBe(changes);
    expect(filterStorageChanges(changes, "LOBBYSTATE")).toHaveLength(2);
    expect(filterStorageChanges(changes, "")).toBe(changes);
    expect(filterStorageChanges(changes, "  ")).toBe(changes);
    expect(matchesQuery("abc", undefined, "xxABCxx")).toBe(true);
    expect(matchesQuery("", "anything")).toBe(true);
    expect(matchesQuery("zzz", "anything")).toBe(false);
  });

  it("searches a capped, cached lowercase copy of each value", () => {
    const change = (eventId: string, value: string) => ({
      eventId,
      mono: 0,
      area: "local" as const,
      op: "setItem",
      key: "big",
      value,
      redacted: false
    });
    const early = change("e1", `${"a".repeat(100)}NEEDLE`);
    const late = change("e2", `${"a".repeat(MAX_SEARCH_VALUE_CHARS)}NEEDLE`);
    const changes = [early, late];

    expect(filterStorageChanges(changes, "needle")).toEqual([early]);
    expect(filterStorageChanges(changes, "NEEDLE")).toEqual([early]);
    expect(filterStorageChanges(changes, "big")).toEqual(changes);
  });

  it("caps hover titles of huge keys and values", () => {
    expect(capTitle(undefined)).toBeUndefined();
    expect(capTitle("short")).toBe("short");
    const title = capTitle("x".repeat(MAX_TITLE_CHARS * 5)) ?? "";
    expect(title).toHaveLength(MAX_TITLE_CHARS + 1);
    expect(title.endsWith("…")).toBe(true);
  });

  it("diffs JSON values field by field and leaves text to the word diff", () => {
    expect(diffJsonValues('{"a":1,"b":{"c":2}}', '{"a":1,"b":{"c":3},"d":true}')).toEqual([
      { path: "b.c", kind: "changed", before: "2", after: "3" },
      { path: "d", kind: "added", after: "true" }
    ]);
    expect(diffJsonValues("[1]", "[]")).toEqual([{ path: "0", kind: "removed", before: "1" }]);
    expect(diffJsonValues("plain", '{"a":1}')).toBeNull();
  });
});
