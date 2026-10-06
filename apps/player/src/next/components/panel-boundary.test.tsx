/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { lazy, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlayerProvider } from "../context.js";
import { createPlayerController } from "../controller.js";
import { createInitialState, type PlayerState } from "../state.js";
import { createStore } from "../store.js";
import { PanelBoundary } from "./panel-boundary.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderWithPlayer(children: ReactNode) {
  const store = createStore<PlayerState>(createInitialState("en", "system"));
  const controller = createPlayerController(store, {
    scheduler: { request: () => 0, cancel: () => undefined }
  });
  return render(<PlayerProvider controller={controller}>{children}</PlayerProvider>);
}

describe("PanelBoundary", () => {
  it("degrades one failing panel to 'failed, retry' and keeps its neighbours", () => {
    // React reports caught render errors on the console; keep the test output clean.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let shouldThrow = true;

    function Flaky() {
      if (shouldThrow) {
        throw new Error("malformed event");
      }

      return <p>recovered</p>;
    }

    renderWithPlayer(
      <>
        <PanelBoundary>
          <Flaky />
        </PanelBoundary>
        <PanelBoundary>
          <p>neighbour</p>
        </PanelBoundary>
      </>
    );

    expect(screen.getByTestId("panel-failed")).toHaveTextContent(
      "This panel failed to render: malformed event"
    );
    expect(screen.getByText("neighbour")).toBeInTheDocument();

    shouldThrow = false;
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(screen.getByText("recovered")).toBeInTheDocument();
    expect(screen.queryByTestId("panel-failed")).not.toBeInTheDocument();
  });

  it("shows a loading line while a lazy panel's chunk loads", async () => {
    type PanelModule = { default: () => ReactElement };
    let resolveChunk: (module: PanelModule) => void = () => undefined;
    const LazyPanel = lazy(
      () =>
        new Promise<PanelModule>((resolve) => {
          resolveChunk = resolve;
        })
    );

    renderWithPlayer(
      <PanelBoundary>
        <LazyPanel />
      </PanelBoundary>
    );
    expect(screen.getByTestId("panel-loading")).toHaveTextContent("Loading…");

    await act(async () => {
      resolveChunk({ default: () => <p>lazy panel</p> });
    });
    expect(screen.getByText("lazy panel")).toBeInTheDocument();
  });
});
