/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildSyntheticSession,
  createPlainArchive,
  type SyntheticSession
} from "../../../../scripts/lib/synthetic-session.mjs";
import { withTabVideo } from "../../../../scripts/lib/synthetic-video.mjs";
import { createMediaUrlCache } from "../../../core/media-cache.js";
import * as exportModule from "../../../lib/export.js";
import { App } from "../../app.js";
import { createPlayerController } from "../../controller.js";
import { createInitialState, type PlayerState } from "../../state.js";
import { createStore } from "../../store.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

const CHUNKS = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6])];

/** The synthetic session's start (first event), formatted like the file name, in local time. */
function fileTime(session: SyntheticSession): string {
  const date = new Date(session.events[0]?.t ?? 0);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}`
  );
}

/** Each part's chunks end with the part's index, so the parts' bytes differ. */
function videoSession(segments = 1): SyntheticSession {
  return withTabVideo(
    buildSyntheticSession(),
    Array.from({ length: segments }, (_, index) => ({
      chunks: CHUNKS.map((bytes) => new Uint8Array([...bytes, index])),
      startOffsetMs: 1_000 + index * 6_000,
      durationMs: 4_000,
      width: 1280,
      height: 720
    }))
  );
}

type RecordingData = { recordingId?: string; index?: number; chunkId?: string; chunks?: string[] };

/** Drops chunk `index` of a part, as when it failed to store (the end lists the rest). */
function dropChunk(session: SyntheticSession, part: number, index: number): SyntheticSession {
  const recordingId = `VR-S-1790000000000-synthetic-${part}`;
  const chunkEvent = session.events.find((event) => {
    const data = event.data as RecordingData;
    return (
      event.type === "screen.recording.chunk" &&
      data.recordingId === recordingId &&
      data.index === index
    );
  });
  const chunkId = (chunkEvent?.data as RecordingData | undefined)?.chunkId;

  return {
    ...session,
    events: session.events
      .filter((event) => event !== chunkEvent)
      .map((event) => {
        const data = event.data as RecordingData;

        if (event.type !== "screen.recording.end" || data.recordingId !== recordingId) {
          return event;
        }

        const chunks = (data.chunks ?? []).filter((id) => id !== chunkId);
        return { ...event, data: { ...data, chunks, chunkCount: chunks.length } };
      })
  };
}

async function renderPlayer(session: SyntheticSession, locale: "en" | "ru" = "en") {
  const bytes = await createPlainArchive(session);
  const store = createStore<PlayerState>(createInitialState(locale, "light"));
  const controller = createPlayerController(store, {
    scheduler: { request: () => 0, cancel: () => undefined },
    mediaCache: createMediaUrlCache({ createUrl: () => "blob:media", revokeUrl: () => undefined })
  });
  render(<App controller={controller} />);
  await act(async () => {
    await controller.openFile({
      name: "synthetic.webblackbox",
      arrayBuffer: async () => bytes.slice().buffer
    });
  });
  return { store, controller };
}

async function openGenerateMenu(): Promise<HTMLElement> {
  fireEvent.click(screen.getByTestId("generate-button"));
  return screen.findByTestId("generate-menu");
}

function spyDownloads(): Array<{ name: string; blob: Blob }> {
  const saved: Array<{ name: string; blob: Blob }> = [];
  vi.spyOn(exportModule, "downloadBlob").mockImplementation((name, blob) => {
    saved.push({ name, blob });
  });
  return saved;
}

/** jsdom's Blob has no `arrayBuffer()`. */
function readBlob(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

function toastOf(element: HTMLElement): HTMLElement | null {
  return element.closest("[data-testid='toast']");
}

describe("Download video", () => {
  it("saves the tab video from the Generate menu under the session's name", async () => {
    const session = videoSession();
    const saved = spyDownloads();
    await renderPlayer(session);

    const menu = await openGenerateMenu();
    const item = within(menu).getByTestId("generate-video");
    expect(item).toHaveTextContent("Download video");
    expect(within(menu).getByTestId("generate-video-detail")).toHaveTextContent("4.00s · 9 B");
    fireEvent.click(item);

    await waitFor(() => expect(saved).toHaveLength(1));
    const [file] = saved;
    expect(file?.name).toBe(`app.example.test-${fileTime(session)}-synthetic.webm`);
    expect(file?.blob.type).toBe("video/webm");
    expect([...(await readBlob(file!.blob))]).toEqual([1, 2, 3, 0, 4, 5, 0, 6, 0]);
    // Not a WebM the SDK can fix: saved as recorded, and the notice says so.
    expect(toastOf(await screen.findByText(`Saved ${file?.name}`))).toHaveTextContent(
      "some players may not show its length"
    );
  });

  it("puts a download button on the transport only when there is a video", async () => {
    const saved = spyDownloads();
    await renderPlayer(videoSession());

    const button = screen.getByTestId("transport-video");
    expect(button).toHaveAccessibleName("Download the tab video, 4.00s · 9 B");
    fireEvent.click(button);
    await waitFor(() => expect(saved).toHaveLength(1));

    cleanup();
    await renderPlayer(buildSyntheticSession());
    expect(screen.queryByTestId("transport-video")).not.toBeInTheDocument();
  });

  it("is disabled with a reason when the recording has no video", async () => {
    await renderPlayer(buildSyntheticSession());

    const menu = await openGenerateMenu();
    expect(within(menu).getByTestId("generate-video")).toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByTestId("generate-video-detail")).toHaveTextContent(
      "This recording has no tab video"
    );
  });

  it("names Lite capture as the reason, in the reader's language", async () => {
    const session = buildSyntheticSession();
    await renderPlayer({ ...session, manifest: { ...session.manifest, mode: "lite" } }, "ru");

    const menu = await openGenerateMenu();
    expect(within(menu).getByTestId("generate-video")).toHaveTextContent("Скачать видео");
    expect(within(menu).getByTestId("generate-video-detail")).toHaveTextContent(
      "Lite-запись не записывает видео вкладки"
    );
  });

  it("offers each part with its time span, and every complete part at once", async () => {
    const session = videoSession(3);
    const saved = spyDownloads();
    await renderPlayer(dropChunk(session, 3, 1));

    const menu = await openGenerateMenu();
    expect(within(menu).getByTestId("generate-video-part-1-detail")).toHaveTextContent(
      /^0:01\.00 – 0:05\.0\d · 9 B$/
    );
    expect(within(menu).getByTestId("generate-video-part-2")).toHaveTextContent(
      "Download video, part 2"
    );
    expect(within(menu).getByTestId("generate-video-part-3")).toHaveAttribute(
      "aria-disabled",
      "true"
    );
    expect(within(menu).getByTestId("generate-video-part-3-detail")).toHaveTextContent(
      "Missing from the archive: chunks 2 of 3"
    );
    expect(within(menu).getByTestId("generate-video-all")).toHaveTextContent(
      "Download all video parts (2)"
    );
    fireEvent.click(within(menu).getByTestId("generate-video-all"));

    await waitFor(() => expect(saved).toHaveLength(2));
    const stem = `app.example.test-${fileTime(session)}-synthetic`;
    expect(saved.map((entry) => entry.name)).toEqual([`${stem}-part1.webm`, `${stem}-part2.webm`]);
    expect(await screen.findByText("Saved 2 video files")).toBeInTheDocument();
  });

  it("opens a parts menu from the transport when the video has several parts", async () => {
    await renderPlayer(videoSession(2));

    fireEvent.click(screen.getByTestId("transport-video"));
    const menu = await screen.findByTestId("transport-video-menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.dataset.testid)
    ).toEqual(["generate-video-part-1", "generate-video-part-2", "generate-video-all"]);
  });

  it("says which chunk the archive lacks when a chunk blob is gone", async () => {
    const session = videoSession();
    const missing = session.blobs.find((blob) => blob.mime === "video/webm");
    const saved = spyDownloads();
    await renderPlayer({ ...session, blobs: session.blobs.filter((blob) => blob !== missing) });

    fireEvent.click(within(await openGenerateMenu()).getByTestId("generate-video"));

    expect(toastOf(await screen.findByText("Could not save the video"))).toHaveTextContent(
      "Missing from the archive: chunks 1 of 3"
    );
    expect(saved).toHaveLength(0);
  });

  it("downloads from the command palette", async () => {
    const saved = spyDownloads();
    const { controller } = await renderPlayer(videoSession());

    act(() => controller.setPaletteOpen(true));
    const palette = await screen.findByTestId("command-palette");
    fireEvent.change(within(palette).getByTestId("palette-input"), {
      target: { value: "tab video" }
    });
    fireEvent.click(await within(palette).findByText("Download the tab video (4.00s · 9 B)"));

    await waitFor(() => expect(saved).toHaveLength(1));
  });
});
