/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createPlainArchive } from "../../../scripts/lib/synthetic-session.mjs";
import { createMediaUrlCache } from "../../core/media-cache.js";
import { App } from "../app.js";
import { PlayerProvider } from "../context.js";
import { createPlayerController } from "../controller.js";
import { createInitialState, type PlayerState } from "../state.js";
import { createStore } from "../store.js";
import { LazyDialog, retryableLazy } from "./lazy-dialog.js";
import { paletteKeyLabel } from "./platform.js";
import * as recordingProfile from "./recording-profile.js";
import { ToastHost } from "./toasts.js";

// "About this recording" behaves like a stale content-hashed chunk after a deploy.
vi.mock("./archive-info.js", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

let archiveBytes: Uint8Array;

beforeAll(async () => {
  archiveBytes = await createPlainArchive();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

async function renderPlayer() {
  const { store, controller } = createController();
  render(<App controller={controller} />);
  await act(async () => {
    await controller.openFile({
      name: "synthetic.webblackbox",
      arrayBuffer: async () => archiveBytes.slice().buffer
    });
  });
  return { store, controller };
}

describe("LazyDialog", () => {
  it("turns a chunk that fails to load into a toast and loads it afresh on Retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const load = vi
      .fn<() => Promise<{ default: () => React.JSX.Element }>>()
      .mockRejectedValueOnce(new Error("chunk-abc123.js 404"))
      .mockResolvedValue({ default: () => <p>dialog body</p> });
    const dialog = retryableLazy(load);
    const { controller } = createController();

    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <p>player</p>
          <LazyDialog
            open={open}
            dialog={dialog}
            onClose={() => setOpen(false)}
            onReopen={() => setOpen(true)}
          />
          <ToastHost />
        </>
      );
    }

    render(
      <PlayerProvider controller={controller}>
        <Host />
      </PlayerProvider>
    );

    expect(await screen.findByTestId("toast")).toHaveTextContent(
      "This panel failed to render: chunk-abc123.js 404"
    );
    expect(screen.getByText("player")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("toast-action"));
    expect(await screen.findByText("dialog body")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps the player and the archive when a lazy dialog's chunk is gone", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { store, controller } = await renderPlayer();

    act(() => controller.setArchiveInfoOpen(true));
    expect(await screen.findByTestId("toast")).toHaveTextContent(/failed/);
    expect(store.getState().archiveInfoOpen).toBe(false);
    expect(store.getState().archive).not.toBeNull();
    expect(screen.getByTestId("player")).toBeInTheDocument();
    expect(screen.getByTestId("workspace")).toBeInTheDocument();
  });
});

describe("Header", () => {
  it("drops only the profile chip when the recording profile cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(recordingProfile, "recordingProfileOf").mockImplementation(() => {
      throw new Error("malformed meta.config");
    });
    await renderPlayer();

    expect(screen.getByTestId("header")).toBeInTheDocument();
    expect(screen.getByTestId("session")).toBeInTheDocument();
    expect(screen.queryByTestId("profile-chip")).not.toBeInTheDocument();
  });

  it("shows the palette key as the platform writes it", () => {
    expect(paletteKeyLabel({ platform: "MacIntel" })).toBe("⌘K");
    expect(paletteKeyLabel({ platform: "", userAgentData: { platform: "macOS" } })).toBe("⌘K");
    expect(paletteKeyLabel({ platform: "Win32" })).toBe("Ctrl K");
    expect(paletteKeyLabel({ platform: "Linux x86_64" })).toBe("Ctrl K");
  });
});
