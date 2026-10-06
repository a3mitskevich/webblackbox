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
import * as generators from "./generators.js";

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
      "Copy bug report",
      // The synthetic recording has no tab video: the entry says so (video-download.test.tsx).
      "Download videoThis recording has no tab video"
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

  it("says so when the bug report cannot be built", async () => {
    vi.spyOn(generators, "buildBugReport").mockImplementation(() => {
      throw new Error("no events");
    });
    await renderLoaded();

    fireEvent.click(screen.getByTestId("generate-button"));
    fireEvent.click(await screen.findByTestId("generate-copy-bug-report"));
    expect(await screen.findByTestId("toast")).toHaveTextContent(
      /Could not copy the bug report.*no events/
    );
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

  it("applies a typed value on blur and still takes a preset clicked right after", async () => {
    const { store, controller } = await renderLoaded();
    const { minMono } = store.getState().archive?.model ?? { minMono: 0 };
    const timeline = { startMono: minMono + 1_000, endMono: minMono + 2_500 };
    act(() => controller.setRange(timeline));
    act(() => openGenerate(store, { kind: "bug-report" }));

    const dialog = await screen.findByRole("dialog", { name: "Bug report" });
    const from = within(dialog).getByTestId("generate-range-from");
    const presetTimeline = within(dialog).getByTestId("generate-range-timeline");
    expect(presetTimeline).toHaveAttribute("aria-pressed", "true");

    // Typing, then a click on a preset: blur commits first, the preset button must survive it.
    fireEvent.change(from, { target: { value: "0.5" } });
    fireEvent.blur(from);
    const summary = within(dialog).getByTestId("generate-range-summary");
    expect(summary).toHaveTextContent("0:00.50 – 0:02.50");
    expect(within(dialog).getByTestId("generate-range-timeline")).toBe(presetTimeline);
    expect(presetTimeline).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(presetTimeline);
    expect(summary).toHaveTextContent("0:01.00 – 0:02.50");
    expect(presetTimeline).toHaveAttribute("aria-pressed", "true");
  });

  it("does not move an untouched range by the rounding of the fields", async () => {
    const { store, controller } = await renderLoaded();
    const { minMono } = store.getState().archive?.model ?? { minMono: 0 };
    // 2006.4 ms shows as "2.01"; re-reading that text would move the start by 3.6 ms.
    const precise = { startMono: minMono + 2_006.4, endMono: minMono + 4_000 };
    act(() => controller.setRange(precise));
    const report = vi.spyOn(generators, "buildBugReport");
    act(() => openGenerate(store, { kind: "bug-report" }));

    const dialog = await screen.findByRole("dialog", { name: "Bug report" });
    const from = within(dialog).getByTestId("generate-range-from");
    expect(from).toHaveValue("2.01");
    await waitFor(() => expect(report).toHaveBeenCalled());

    fireEvent.focus(from);
    fireEvent.blur(from);
    fireEvent.keyDown(within(dialog).getByTestId("generate-range-to"), { key: "Enter" });
    expect(within(dialog).getByTestId("generate-range-timeline")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    for (const [, range] of report.mock.calls) {
      expect(range).toEqual(precise);
    }
  });

  it("flags an empty or too short typed range and keeps the applied one", async () => {
    const { store } = await renderLoaded();
    const { minMono } = store.getState().archive?.model ?? { minMono: 0 };
    act(() =>
      openGenerate(store, {
        kind: "bug-report",
        range: { startMono: minMono + 2_000, endMono: minMono + 4_000 }
      })
    );

    const dialog = await screen.findByRole("dialog", { name: "Bug report" });
    const from = within(dialog).getByTestId("generate-range-from");
    const to = within(dialog).getByTestId("generate-range-to");
    const summary = within(dialog).getByTestId("generate-range-summary");

    fireEvent.change(to, { target: { value: "" } });
    fireEvent.blur(to);
    expect(within(dialog).getByTestId("generate-range-error")).toHaveTextContent(
      "Enter the time in seconds"
    );
    expect(to).toHaveAttribute("aria-invalid", "true");
    expect(from).not.toHaveAttribute("aria-invalid");
    expect(to).toHaveAccessibleDescription(/Enter the time in seconds/);
    expect(summary).toHaveTextContent("0:02.00 – 0:04.00");

    fireEvent.change(to, { target: { value: "2.02" } });
    expect(within(dialog).queryByTestId("generate-range-error")).toBeNull();
    fireEvent.keyDown(to, { key: "Enter" });
    expect(within(dialog).getByTestId("generate-range-error")).toHaveTextContent(
      "The range must be at least 50 ms long"
    );
    expect(summary).toHaveTextContent("0:02.00 – 0:04.00");

    fireEvent.click(within(dialog).getByTestId("generate-range-whole"));
    expect(within(dialog).queryByTestId("generate-range-error")).toBeNull();
    expect(to).not.toHaveAttribute("aria-invalid");
  });

  it("shows Generating… before a generator runs", async () => {
    const { store } = await renderLoaded();
    const report = vi.spyOn(generators, "buildBugReport");
    act(() => openGenerate(store, { kind: "bug-report" }));

    const dialog = await screen.findByRole("dialog", { name: "Bug report" });
    expect(within(dialog).getByTestId("generate-pending")).toHaveTextContent("Generating…");
    expect(report).not.toHaveBeenCalled();
    expect(await previewText()).toContain("## Session");
  });

  it("names the HAR the Playwright test replays as the HAR dialog saves it", async () => {
    const { store } = await renderLoaded();
    act(() => openGenerate(store, { kind: "playwright" }));

    const dialog = await screen.findByRole("dialog", { name: "Playwright test" });
    expect(dialog).toHaveAccessibleDescription(/webblackbox-session\.har next to the test/);
    expect(within(dialog).getByTestId("generate-include-har").parentElement).toHaveTextContent(
      "Replay the network from webblackbox-session.har"
    );
    expect(await previewText()).toContain("routeFromHAR('./webblackbox-session.har'");
  });

  it("keeps the player when a generator dialog throws, and retries on request", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const startUrl = vi.spyOn(generators, "resolveStartUrl").mockImplementation(() => {
      throw new Error("broken route chapters");
    });
    const { store } = await renderLoaded();
    act(() => openGenerate(store, { kind: "playwright" }));

    expect(await screen.findByTestId("toast")).toHaveTextContent(
      "This panel failed to render: broken route chapters"
    );
    expect(generateSlice.select(store.getState()).request).toBeNull();
    expect(store.getState().archive).not.toBeNull();
    expect(screen.getByTestId("workspace")).toBeInTheDocument();

    startUrl.mockRestore();
    fireEvent.click(screen.getByTestId("toast-action"));
    expect(await screen.findByRole("dialog", { name: "Playwright test" })).toBeInTheDocument();
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
