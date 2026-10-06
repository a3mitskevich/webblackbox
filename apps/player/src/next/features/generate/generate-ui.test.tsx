/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createPlainArchive } from "../../../../scripts/lib/synthetic-session.mjs";
import { createMediaUrlCache } from "../../../core/media-cache.js";
import * as exportModule from "../../../lib/export.js";
import { App } from "../../app.js";
import { createPlayerController } from "../../controller.js";
import { createInitialState, type PlayerState } from "../../state.js";
import { createStore } from "../../store.js";
import { generateSlice, openGenerate } from "./api.js";

let archiveBytes: Uint8Array;

beforeAll(async () => {
  archiveBytes = await createPlainArchive();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

async function renderLoaded() {
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

/** The preview's visible lines (the virtual list renders a first window in jsdom). */
async function previewText(): Promise<string> {
  const preview = await screen.findByTestId("generate-preview");
  return preview.textContent ?? "";
}

describe("Generate menu", () => {
  it("lists every generator and the range it applies to", async () => {
    const { controller, store } = await renderLoaded();

    fireEvent.click(screen.getByTestId("generate-button"));
    const menu = await screen.findByTestId("generate-menu");
    expect(within(menu).getByTestId("generate-menu-range")).toHaveTextContent("Whole session");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent)
    ).toEqual([
      "Playwright test…",
      "Playwright test with mocks…",
      "Bug report…",
      "HAR file…",
      "GitHub issue…",
      "Jira issue…",
      "Copy bug report"
    ]);
    fireEvent.click(within(menu).getByTestId("generate-har"));
    expect(generateSlice.select(store.getState()).request).toEqual({ kind: "har" });
    await screen.findByTestId("generate-dialog-har");

    act(() => {
      controller.store.setState((state) => ({ ...state, slices: {} }));
      const { minMono } = store.getState().archive?.model ?? { minMono: 0 };
      controller.setRange({ startMono: minMono + 1_000, endMono: minMono + 2_500 });
    });
    fireEvent.click(screen.getByTestId("generate-button"));
    expect(await screen.findByTestId("generate-menu-range")).toHaveTextContent(
      "Range 0:01.00 – 0:02.50"
    );
  });

  it("copies the bug report in one step", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await renderLoaded();

    fireEvent.click(screen.getByTestId("generate-button"));
    fireEvent.click(await screen.findByTestId("generate-copy-bug-report"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(String(writeText.mock.calls[0]?.[0])).toContain("## Not Captured");
  });
});

describe("Generate dialogs", () => {
  it("regenerates the Playwright test with new options and downloads it", async () => {
    const download = vi.spyOn(exportModule, "downloadTextFile").mockImplementation(() => undefined);
    const { store } = await renderLoaded();
    act(() => openGenerate(store, { kind: "playwright" }));

    const dialog = await screen.findByRole("dialog", { name: "Playwright test" });
    expect(await previewText()).toContain("routeFromHAR");
    expect(within(dialog).getByTestId("generate-range-summary")).toHaveTextContent("Whole session");

    fireEvent.click(within(dialog).getByTestId("generate-include-har"));
    await waitFor(async () => expect(await previewText()).toContain("HAR replay disabled"));

    const before = (await previewText()).length;
    fireEvent.change(within(dialog).getByTestId("generate-max-actions"), {
      target: { value: "1" }
    });
    fireEvent.click(within(dialog).getByTestId("generate-regenerate"));
    await waitFor(async () => expect((await previewText()).length).toBeLessThan(before));

    fireEvent.click(within(dialog).getByTestId("generate-download"));
    expect(download).toHaveBeenCalledWith(
      "webblackbox-replay.spec.ts",
      expect.stringContaining("import { test }"),
      "text/plain"
    );
    expect(screen.getByTestId("generate-download-status")).toHaveTextContent(
      "Saved webblackbox-replay.spec.ts"
    );

    fireEvent.click(within(dialog).getByTestId("generate-close"));
    await waitFor(() => expect(screen.queryByTestId("generate-dialog-playwright")).toBeNull());
    expect(generateSlice.select(store.getState()).request).toBeNull();
  });

  it("starts from the request's range, then lets the user type or reset it", async () => {
    const { store } = await renderLoaded();
    const { minMono } = store.getState().archive?.model ?? { minMono: 0 };
    act(() =>
      openGenerate(store, {
        kind: "bug-report",
        range: { startMono: minMono + 2_000, endMono: minMono + 4_000 }
      })
    );

    const dialog = await screen.findByRole("dialog", { name: "Bug report" });
    // A new range remounts the fields: query the summary afresh each time.
    const summary = () => within(dialog).getByTestId("generate-range-summary");
    expect(summary()).toHaveTextContent("0:02.00 – 0:04.00");
    expect(within(dialog).getByTestId("generate-range-from")).toHaveValue("2.00");

    const to = within(dialog).getByTestId("generate-range-to");
    fireEvent.change(to, { target: { value: "5" } });
    fireEvent.keyDown(to, { key: "Enter" });
    expect(summary()).toHaveTextContent("0:02.00 – 0:05.00");

    fireEvent.click(within(dialog).getByTestId("generate-range-whole"));
    expect(summary()).toHaveTextContent("Whole session");
    expect(await previewText()).toContain("## Session");
  });

  it("shows the HAR size and the issue templates", async () => {
    const { store } = await renderLoaded();
    act(() => openGenerate(store, { kind: "har" }));
    const har = await screen.findByRole("dialog", { name: "HAR file" });
    expect(await within(har).findByTestId("generate-har-summary")).toHaveTextContent(
      /\d+ requests/
    );
    fireEvent.click(within(har).getByTestId("generate-close"));
    await waitFor(() => expect(screen.queryByTestId("generate-dialog-har")).toBeNull());

    act(() => openGenerate(store, { kind: "jira-issue" }));
    const jira = await screen.findByRole("dialog", { name: "Jira issue" });
    const title = (await within(jira).findByTestId("generate-issue-title")) as HTMLInputElement;
    expect(title.value).toMatch(/^WebBlackbox: /);
    expect(within(jira).getByTestId("generate-issue-labels")).toHaveTextContent("flight-recorder");
  });

  it("closes when another archive opens", async () => {
    const { store, controller } = await renderLoaded();
    act(() => openGenerate(store, { kind: "github-issue" }));
    await screen.findByRole("dialog", { name: "GitHub issue" });

    await act(async () => {
      await controller.openFile({
        name: "other.webblackbox",
        arrayBuffer: async () => archiveBytes.slice().buffer
      });
    });
    await waitFor(() => expect(screen.queryByTestId("generate-dialog-github-issue")).toBeNull());
    expect(generateSlice.select(store.getState()).request).toBeNull();
  });
});
