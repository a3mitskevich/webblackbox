/* @vitest-environment jsdom */

import { WebBlackboxPlayer } from "@webblackbox/player-sdk";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { createPlainArchive } from "../../scripts/lib/synthetic-session.mjs";
import { createMediaUrlCache } from "../core/media-cache.js";
import type { FrameScheduler } from "../core/playback-clock.js";
import {
  createPlayerController,
  type ListStepItem,
  resolveSelectedEventId,
  resolveSelectionMono,
  selectActivityEvents,
  type PlayerControllerOptions
} from "./controller.js";
import { createInitialState, type PlayerState } from "./state.js";
import { createStore } from "./store.js";

let archiveBytes: Uint8Array;

beforeAll(async () => {
  archiveBytes = await createPlainArchive();
});

function source(name = "session.webblackbox") {
  return {
    name,
    arrayBuffer: async () => archiveBytes.slice().buffer
  };
}

function fakeScheduler() {
  const queue = new Map<number, (timestamp: number) => void>();
  let handle = 0;
  let time = 0;
  const scheduler: FrameScheduler = {
    request(callback) {
      handle += 1;
      queue.set(handle, callback);
      return handle;
    },
    cancel(id) {
      queue.delete(id);
    }
  };
  return {
    scheduler,
    frame(ms: number) {
      time += ms;
      const callbacks = [...queue.values()];
      queue.clear();
      callbacks.forEach((callback) => callback(time));
    }
  };
}

/** Opens the plain synthetic archive, but only with passphrase "right" (like an encrypted one). */
const encryptedOpen: PlayerControllerOptions["open"] = async (bytes, options) => {
  if (!options?.passphrase) {
    throw new Error("Archive is encrypted. Provide a passphrase to open it.");
  }

  if (options.passphrase !== "right") {
    const error = new Error("The operation failed");
    error.name = "OperationError";
    throw error;
  }

  return WebBlackboxPlayer.open(bytes);
};

function setup(options: PlayerControllerOptions = {}) {
  const store = createStore<PlayerState>(createInitialState("en", "system"));
  const timer = fakeScheduler();
  const persistLocale = vi.fn();
  const persistTheme = vi.fn();
  const controller = createPlayerController(store, {
    scheduler: timer.scheduler,
    persistLocale,
    persistTheme,
    mediaCache: createMediaUrlCache({ createUrl: () => "blob:shot", revokeUrl: () => undefined }),
    ...options
  });
  return { store, controller, timer, persistLocale, persistTheme };
}

async function waitForPhase(store: ReturnType<typeof setup>["store"], phase: string) {
  await vi.waitFor(() => expect(store.getState().status.phase).toBe(phase));
}

async function loaded(options: PlayerControllerOptions = {}) {
  const context = setup(options);
  await context.controller.openFile(source());
  return context;
}

describe("opening archives", () => {
  it("rejects files that are not archives", async () => {
    const { store, controller } = setup();

    await controller.openFile({ name: "notes.txt", arrayBuffer: async () => new ArrayBuffer(0) });

    expect(store.getState().status).toMatchObject({ phase: "error", fileName: "notes.txt" });
    controller.dismissError();
    expect(store.getState().status.phase).toBe("empty");
  });

  it("asks for the passphrase until it decrypts the archive", async () => {
    const { store, controller } = setup({ open: encryptedOpen });
    const opening = controller.openFile(source("secret.zip"));

    await waitForPhase(store, "passphrase");
    expect(store.getState().status).toMatchObject({ invalid: false, fileName: "secret.zip" });

    controller.submitPassphrase("wrong");
    await vi.waitFor(() => expect(store.getState().status).toMatchObject({ invalid: true }));

    controller.submitPassphrase("right");
    await opening;

    const state = store.getState();
    expect(state.status.phase).toBe("ready");
    expect(state.archive?.fileName).toBe("secret.zip");
    expect(state.playheadMono).toBe(state.archive?.model.minMono);
    expect(state.announcement).toBe("Loaded secret.zip.");
  });

  it("returns to the empty state when the passphrase prompt is cancelled", async () => {
    const { store, controller } = setup({ open: encryptedOpen });
    const opening = controller.openFile(source());

    await waitForPhase(store, "passphrase");
    controller.cancelPassphrase();
    await opening;

    expect(store.getState().status.phase).toBe("empty");
  });

  it("settles the passphrase prompt of a file that a newer file replaces", async () => {
    const { store, controller } = setup({ open: encryptedOpen });
    const first = controller.openFile(source("first.zip"));
    await waitForPhase(store, "passphrase");

    await controller.openFile({ name: "notes.txt", arrayBuffer: async () => new ArrayBuffer(0) });
    await first;
    expect(store.getState().status).toMatchObject({ phase: "error", fileName: "notes.txt" });

    const second = controller.openFile(source("second.zip"));
    await waitForPhase(store, "passphrase");
    const third = controller.openFile(source("third.zip"));
    await second;
    await vi.waitFor(() =>
      expect(store.getState().status).toMatchObject({ phase: "passphrase", fileName: "third.zip" })
    );

    controller.submitPassphrase("right");
    await third;
    expect(store.getState().archive?.fileName).toBe("third.zip");
  });

  it("reports archives that cannot be read", async () => {
    const { store, controller } = setup({
      open: async () => {
        throw new Error("End of central directory not found");
      }
    });

    await controller.openFile(source("broken.zip"));

    expect(store.getState().status).toEqual({
      phase: "error",
      fileName: "broken.zip",
      message: "End of central directory not found"
    });
  });

  it("applies a hash that arrived before the archive", async () => {
    const { store, controller } = setup();

    controller.applyHash({
      offsetMs: 10_890,
      selection: { kind: "request", id: "90080.1706" },
      tab: "network"
    });
    await controller.openFile(source());

    const state = store.getState();
    expect(state.playheadMono - (state.archive?.model.minMono ?? 0)).toBe(10_890);
    expect(state.selection).toEqual({ kind: "request", id: "90080.1706" });
    expect(state.tab).toBe("network");
  });

  it("leaves playback alone for a hash without player state", async () => {
    const { store, controller } = await loaded();
    controller.play();
    const before = store.getState();

    controller.applyHash({});

    expect(store.getState()).toBe(before);
    expect(store.getState().isPlaying).toBe(true);
  });
});

describe("playback", () => {
  it("plays on the frame clock and stops at the end", async () => {
    const { store, controller, timer } = await loaded();
    const model = store.getState().archive?.model;

    if (!model) {
      throw new Error("archive not loaded");
    }

    controller.setSkipIdle(false);
    controller.play();
    timer.frame(16);
    timer.frame(500);
    expect(store.getState().isPlaying).toBe(true);
    expect(store.getState().playheadMono).toBe(model.minMono + 500);

    controller.setRate(2);
    timer.frame(100);
    expect(store.getState().playheadMono).toBe(model.minMono + 700);

    controller.togglePlay();
    expect(store.getState().isPlaying).toBe(false);

    controller.seekEdge("end");
    controller.togglePlay();
    expect(store.getState().playheadMono).toBe(model.minMono);
    timer.frame(16);
    timer.frame(60_000);
    expect(store.getState()).toMatchObject({ isPlaying: false, playheadMono: model.maxMono });
  });

  it("skips idle stretches faster than real time", async () => {
    const { store, controller, timer } = await loaded();
    const minMono = store.getState().archive?.model.minMono ?? 0;

    // 6.50 s → 9.42 s has no events: an idle gap (with margins) around 7.5 s.
    controller.seek(minMono + 7_500);
    controller.play();
    timer.frame(16);
    timer.frame(100);
    expect(store.getState().playheadMono - minMono).toBeGreaterThan(7_500 + 100);
    controller.pause();
  });

  it("seeks by steps and edges", async () => {
    const { store, controller } = await loaded();
    const minMono = store.getState().archive?.model.minMono ?? 0;

    controller.seekBy("step", 1);
    controller.seekBy("large-step", 1);
    expect(store.getState().playheadMono - minMono).toBe(6_000);
    controller.seekBy("frame", -1);
    expect(store.getState().playheadMono - minMono).toBeCloseTo(6_000 - 1_000 / 30);
    controller.seekEdge("start");
    controller.seekBy("step", -1);
    expect(store.getState().playheadMono).toBe(minMono);
  });

  it("names jumps with the injected event description", async () => {
    const { store, controller } = await loaded({
      describeEvent: (_archive, event) => `described ${event.id}`
    });

    controller.stepError(1);
    const selected = store.getState().selection?.id;
    expect(store.getState().announcement).toMatch(
      new RegExp(`^Error 1 of \\d+: described ${selected}, `)
    );
  });

  it("keeps a timeline range inside the recording; [ and ] move its ends to the playhead", async () => {
    const { store, controller } = await loaded();
    const { minMono, maxMono } = store.getState().archive?.model ?? { minMono: 0, maxMono: 0 };

    controller.setRange({ startMono: minMono + 4_000, endMono: minMono - 500 });
    expect(store.getState().range).toEqual({ startMono: minMono, endMono: minMono + 4_000 });

    controller.seek(minMono + 2_000);
    controller.markRange("start");
    expect(store.getState().range).toEqual({
      startMono: minMono + 2_000,
      endMono: minMono + 4_000
    });

    controller.clearRange();
    controller.seek(minMono + 3_000);
    controller.markRange("end");
    expect(store.getState().range).toEqual({ startMono: minMono, endMono: minMono + 3_000 });

    // `[` on the range's own end would collapse it: the range stays and the reason is announced.
    controller.markRange("start");
    expect(store.getState().range).toEqual({ startMono: minMono, endMono: minMono + 3_000 });
    expect(store.getState().announcement).toMatch(/^Range too short/);

    // A click-sized range is no range; a new archive starts without one.
    controller.setRange({ startMono: minMono + 10, endMono: minMono + 20 });
    expect(store.getState().range).toBeNull();
    controller.setRange({ startMono: minMono, endMono: maxMono });
    await controller.openFile(source());
    expect(store.getState().range).toBeNull();
  });
});

describe("navigation and selection", () => {
  it("jumps between errors, list items and actions with announcements", async () => {
    const { store, controller } = await loaded();
    const archive = store.getState().archive;

    if (!archive) {
      throw new Error("archive not loaded");
    }

    // E steps through problem occurrences: failed requests, console errors, exceptions.
    const errors = archive.view.errorEvents;
    controller.stepError(1);
    expect(store.getState().selection?.id).toBe(errors[0]?.id);
    expect(store.getState().announcement).toMatch(new RegExp(`^Error 1 of ${errors.length}: `));

    controller.seekEdge("end");
    controller.stepError(1);
    expect(store.getState().announcement).toBe("No more errors in this direction.");
    controller.stepError(-1);
    const error = store.getState();
    expect(error.selection?.id).toBe(errors[errors.length - 1]?.id);
    expect(error.announcement).toMatch(new RegExp(`^Error ${errors.length} of ${errors.length}: `));

    controller.stepList(1);
    const next = store.getState();
    const list = selectActivityEvents(archive, "");
    const errorIndex = list.findIndex((event) => event.id === error.selection?.id);
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(next.selection?.id).toBe(list[errorIndex + 1]?.id);

    controller.seekEdge("start");
    controller.nextAction();
    expect(store.getState().selection?.id).toBe(archive.model.actionTimeline[0]?.triggerEventId);

    controller.seekEdge("end");
    controller.nextAction();
    expect(store.getState().announcement).toBe("No more actions in this direction.");
    controller.clearSelection();
    controller.stepList(1);
    expect(store.getState().announcement).toBe("No more events in this direction.");
  });

  it("steps through the active tab's own rows when it provides them", async () => {
    const stepItems = (state: PlayerState): ListStepItem[] | null =>
      state.tab === "network" && state.archive
        ? state.archive.model.waterfall.map((entry) => ({
            selection: { kind: "request", id: entry.reqId },
            mono: entry.startMono
          }))
        : null;
    const { store, controller } = await loaded({ stepItems });
    const waterfall = store.getState().archive?.model.waterfall ?? [];

    controller.setTab("network");
    controller.stepList(1);
    expect(store.getState().selection).toEqual({ kind: "request", id: waterfall[0]?.reqId });
    controller.stepList(1);
    expect(store.getState().selection).toEqual({ kind: "request", id: waterfall[1]?.reqId });
    controller.stepList(-1);
    expect(store.getState().selection).toEqual({ kind: "request", id: waterfall[0]?.reqId });

    // Another tab without its own rows steps through the Activity events.
    controller.setTab("activity");
    controller.stepList(1);
    expect(store.getState().selection?.kind).toBe("event");
  });

  it("selects requests and actions at their time and maps them to list rows", async () => {
    const { store, controller } = await loaded();
    const archive = store.getState().archive;

    if (!archive) {
      throw new Error("archive not loaded");
    }

    controller.select({ kind: "request", id: "90080.1706" });
    expect(store.getState().playheadMono).toBe(
      archive.model.waterfallByReqId.get("90080.1706")?.startMono
    );
    const requestRow = resolveSelectedEventId(archive, store.getState().selection);
    expect(archive.model.eventById.get(requestRow ?? "")?.type).toBe("network.request");

    const action = archive.model.actionTimeline[1];
    controller.select({ kind: "action", id: action?.actId ?? "" });
    expect(resolveSelectedEventId(archive, store.getState().selection)).toBe(
      action?.triggerEventId
    );
    expect(resolveSelectionMono(archive, { kind: "event", id: "missing" })).toBeNull();
    expect(resolveSelectedEventId(archive, null)).toBeNull();

    const before = store.getState().selection;
    controller.select({ kind: "request", id: "missing" });
    expect(store.getState().selection).toEqual(before);
  });

  it("filters the activity list by the query", async () => {
    const { store, controller } = await loaded();
    const archive = store.getState().archive;

    if (!archive) {
      throw new Error("archive not loaded");
    }

    controller.setQuery("casino-user");
    const rows = selectActivityEvents(archive, store.getState().query);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(selectActivityEvents(archive, "").length);
  });
});

describe("preferences and layers", () => {
  it("switches the language in place and persists it", async () => {
    const { store, controller, persistLocale } = await loaded();
    const before = store.getState();

    controller.setLocale("ru");
    controller.setLocale("ru");

    expect(persistLocale).toHaveBeenCalledTimes(1);
    expect(document.documentElement.lang).toBe("ru");
    expect(store.getState()).toMatchObject({
      locale: "ru",
      archive: before.archive,
      playheadMono: before.playheadMono
    });
  });

  it("opens and closes the details, the shortcut sheet and the drop overlay", async () => {
    const { store, controller, persistTheme } = await loaded();

    controller.openDetails();
    expect(store.getState().detailsOpen).toBe(false);
    controller.stepError(1);
    controller.openDetails();
    controller.setShortcutsOpen(true);
    controller.close();
    expect(store.getState()).toMatchObject({ shortcutsOpen: false, detailsOpen: true });
    controller.close();
    expect(store.getState().detailsOpen).toBe(false);

    controller.setDragActive(true);
    controller.setDragActive(true);
    expect(store.getState().dragActive).toBe(true);
    controller.setTheme("dark");
    controller.setTab("console");
    controller.setFollow(false);
    controller.setRate(-1);
    expect(store.getState()).toMatchObject({
      theme: "dark",
      tab: "console",
      follow: false,
      rate: 1
    });
    expect(persistTheme).toHaveBeenCalledWith("dark");
  });

  it("serves stage media through the cache and only while an archive is open", async () => {
    const empty = setup();
    expect(await empty.controller.loadScreenshotUrl("x")).toBeNull();

    const { store, controller } = await loaded();
    const shot = store.getState().archive?.model.screenshots[0];

    expect(await controller.loadScreenshotUrl(shot?.shotId ?? "")).toBe("blob:shot");
    expect(await controller.loadScreenshotUrl("missing")).toBeNull();
    expect(
      await controller.loadRecordingUrl({
        eventId: "E",
        recordingId: "R",
        source: null,
        mime: "video/webm",
        startMono: 0,
        endMono: 1,
        durationMs: 1,
        chunks: ["missing-chunk"],
        chunkCount: 1,
        size: null
      })
    ).toBeNull();
    controller.dispose();
  });
});
