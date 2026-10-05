/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

describe("Tabs panel", () => {
  it("shows the other tabs open at the playhead and seeks to a change", async () => {
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
    act(() => controller.setTab("tabs"));
    await screen.findByTestId("tabs-panel");
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
});
