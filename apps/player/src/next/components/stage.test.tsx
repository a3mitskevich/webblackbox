/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPlainArchive } from "../../../scripts/lib/synthetic-session.mjs";
import type { ScreenRecordingRecord } from "../../core/archive-model.js";
import { createMediaUrlCache } from "../../core/media-cache.js";
import { App } from "../app.js";
import { PlayerProvider } from "../context.js";
import { createPlayerController } from "../controller.js";
import { createInitialState, type PlayerState } from "../state.js";
import { createStore } from "../store.js";
import { RecordingView } from "./stage.js";

let archiveBytes: Uint8Array;

beforeAll(async () => {
  archiveBytes = await createPlainArchive();
});

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

async function openedAt(offsetMs: number) {
  const store = createStore<PlayerState>(createInitialState("en", "system"));
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
  act(() => {
    controller.seek((store.getState().archive?.model.minMono ?? 0) + offsetMs);
  });
  return { store, controller };
}

/** The stage media reports its natural size (jsdom loads no images). */
async function loadFrame(width: number, height: number): Promise<void> {
  const image = await screen.findByTestId("stage-image", {}, { timeout: 5_000 });
  Object.defineProperty(image, "naturalWidth", { value: width, configurable: true });
  Object.defineProperty(image, "naturalHeight", { value: height, configurable: true });
  act(() => {
    fireEvent.load(image);
  });
}

describe("Stage pointer layer", () => {
  it("covers the whole frame when the media has the viewport's aspect", async () => {
    await openedAt(10_890);
    await loadFrame(1920, 1080);

    const box = screen.getByTestId("pointer-box");
    expect(box.style.left).toBe("0%");
    expect(box.style.top).toBe("0%");
    expect(box.style.width).toBe("100%");
    expect(box.style.height).toBe("100%");
    // The synthetic page is 960×540 CSS px: the overlay speaks its coordinates.
    expect(screen.getByTestId("pointer-layer")).toHaveAttribute("viewBox", "0 0 960 540");
  });

  it("sits on the page's rectangle when the frame letterboxes it", async () => {
    await openedAt(10_890);
    // A 1280×1080 frame holding the 16:9 page: 1280×720 content, 180 px bars above and below.
    await loadFrame(1280, 1080);

    const box = screen.getByTestId("pointer-box");
    expect(box.style.left).toBe("0%");
    expect(box.style.top).toBe("16.6667%");
    expect(box.style.width).toBe("100%");
    expect(box.style.height).toBe("66.6667%");
    expect(screen.getByTestId("pointer-layer")).toHaveAttribute("viewBox", "0 0 960 540");
  });
});

describe("Stage tab video", () => {
  const recording: ScreenRecordingRecord = {
    eventId: "E-rec",
    recordingId: "VR-1",
    source: "tab",
    mime: "video/webm",
    startMono: 1_000,
    endMono: 21_000,
    durationMs: 20_000,
    chunks: [],
    chunkCount: 0,
    size: null
  };

  it("shows the playhead's frame once the video loads while paused (a #t= link)", () => {
    const store = createStore<PlayerState>(createInitialState("en", "system"));
    const controller = createPlayerController(store);
    render(
      <PlayerProvider controller={controller}>
        <RecordingView
          recording={recording}
          url="blob:video"
          playheadMono={12_150}
          isPlaying={false}
          rate={1}
          onSize={() => undefined}
        />
      </PlayerProvider>
    );

    // Before the metadata arrives the element cannot seek (readyState 0).
    const video = screen.getByTestId("stage-video") as HTMLVideoElement;
    let currentTime = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => {
        currentTime = value;
      }
    });
    expect(currentTime).toBe(0);

    // MediaRecorder WebM: no duration until scanned.
    Object.defineProperty(video, "readyState", { configurable: true, value: 1 });
    Object.defineProperty(video, "duration", { configurable: true, value: Infinity });
    act(() => {
      fireEvent.loadedMetadata(video);
    });
    expect(currentTime).toBeCloseTo(11.15, 6);
  });
});
