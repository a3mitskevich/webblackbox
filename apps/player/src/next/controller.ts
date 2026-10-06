import type { WebBlackboxEvent } from "@webblackbox/protocol";
import type { WebBlackboxPlayer } from "@webblackbox/player-sdk";

import {
  openArchiveWithPassphrase,
  OpenArchiveError,
  type ArchiveOpener,
  type PassphraseRequest
} from "../core/archive-open.js";
import { buildArchiveModel, type ScreenRecordingRecord } from "../core/archive-model.js";
import { isActivityEvent } from "../core/event-row.js";
import { filterTimelineEvents } from "../core/filters.js";
import { formatClock, formatOffset } from "../core/format.js";
import { createMediaUrlCache, type MediaUrlCache } from "../core/media-cache.js";
import { findByTime, stepInList, type Direction, type Selection } from "../core/navigation.js";
import {
  advancePlayhead,
  clampMono,
  createFrameLoop,
  PLAYBACK_FRAME_MS,
  PLAYBACK_LARGE_STEP_MS,
  PLAYBACK_STEP_MS,
  resolvePlayStart,
  type FrameLoop,
  type FrameScheduler
} from "../core/playback-clock.js";
import { storeThemePreference, type ThemePreference } from "../core/preferences.js";
import { buildSessionView } from "../core/session-view.js";
import { isSameRange, moveRangeEdge, normalizeRange, type TimeRange } from "../core/time-range.js";
import type { HashState, RailTab } from "../core/url-hash.js";
import {
  applyPlayerDocumentLocale,
  createPlayerI18n,
  storePlayerLocale,
  type PlayerLocale
} from "../lib/i18n.js";
import { isReplayResourceAllowedByDefault } from "../lib/replay.js";
import { readEventSummaryText } from "../lib/signal-text.js";
import { compactText } from "../lib/text.js";
import type { LoadedArchive, PlayerState } from "./state.js";
import type { Store } from "./store.js";

/** A file-like input: a `File` in the browser, any `{ name, arrayBuffer }` in tests. */
export type ArchiveSource = {
  name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
};

/** An item J / L step through: what to select and when it happens. */
export type ListStepItem = {
  selection: Selection;
  mono: number;
};

export type PlayerControllerOptions = {
  scheduler?: FrameScheduler;
  open?: ArchiveOpener<WebBlackboxPlayer>;
  mediaCache?: MediaUrlCache;
  /** Persists the locale and theme choice; defaults to localStorage. */
  persistLocale?: (locale: PlayerLocale) => void;
  persistTheme?: (theme: ThemePreference) => void;
  /**
   * The list J / L step through in the current state (the active rail tab's rows); `null` falls
   * back to the Activity events.
   */
  stepItems?: (state: PlayerState) => readonly ListStepItem[] | null;
};

export type SeekStep = "step" | "large-step" | "frame";

const SEEK_STEP_MS: Record<SeekStep, number> = {
  step: PLAYBACK_STEP_MS,
  "large-step": PLAYBACK_LARGE_STEP_MS,
  frame: PLAYBACK_FRAME_MS
};

const ARCHIVE_NAME_PATTERN = /\.(webblackbox|zip)$/i;
const ANNOUNCE_LABEL_MAX = 72;

const browserScheduler: FrameScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => window.cancelAnimationFrame(handle)
};

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

/** Events of the Activity list (R1): activity rows matching the text filter, all times. */
export function selectActivityEvents(archive: LoadedArchive, query: string): WebBlackboxEvent[] {
  const { model } = archive;
  const matching = query.trim()
    ? filterTimelineEvents(model, model.events.length, { text: query, type: "all", scope: "all" })
    : model.events;

  return matching.filter(isActivityEvent);
}

/**
 * Everything the React player does that is not rendering: opening and decrypting archives, the
 * playback clock, seeking, the single selection, keyboard commands and stage media URLs. React
 * components read the store and call these methods.
 */
export function createPlayerController(
  store: Store<PlayerState>,
  options: PlayerControllerOptions = {}
) {
  const mediaCache = options.mediaCache ?? createMediaUrlCache();
  const persistLocale = options.persistLocale ?? storePlayerLocale;
  const persistTheme = options.persistTheme ?? storeThemePreference;
  let loadToken = 0;
  let pendingPassphrase: ((value: string | null) => void) | null = null;
  let pendingHash: HashState | null = null;

  const update = (patch: Partial<PlayerState>): void => {
    store.setState((state) => ({ ...state, ...patch }));
  };

  const i18n = () => createPlayerI18n(store.getState().locale);

  const loop: FrameLoop = createFrameLoop(options.scheduler ?? browserScheduler, (elapsedMs) => {
    const state = store.getState();
    const archive = state.archive;

    if (!archive || !state.isPlaying) {
      return false;
    }

    const next = advancePlayhead({
      playheadMono: state.playheadMono,
      elapsedMs,
      rate: state.rate,
      bounds: { minMono: archive.model.minMono, maxMono: archive.model.maxMono },
      idleGaps: state.skipIdle ? archive.view.idleGaps : null
    });

    update({ playheadMono: next.playheadMono, isPlaying: !next.ended });
    return !next.ended;
  });

  const bounds = (archive: LoadedArchive) => ({
    minMono: archive.model.minMono,
    maxMono: archive.model.maxMono
  });

  const pause = (): void => {
    loop.stop();

    if (store.getState().isPlaying) {
      update({ isPlaying: false });
    }
  };

  const seek = (mono: number, patch: Partial<PlayerState> = {}): void => {
    const archive = store.getState().archive;

    if (!archive) {
      return;
    }

    pause();
    update({ ...patch, playheadMono: clampMono(mono, bounds(archive)) });
  };

  const describe = (event: WebBlackboxEvent, archive: LoadedArchive): string => {
    const time = formatOffset(event.mono - archive.model.minMono, store.getState().locale);
    const summary = compactText(readEventSummaryText(event), ANNOUNCE_LABEL_MAX);
    return i18n().tn("announceSeek", { label: `${event.type} ${summary}`.trim(), time });
  };

  const selectEvent = (event: WebBlackboxEvent, announcement?: string): void => {
    const archive = store.getState().archive;

    if (!archive) {
      return;
    }

    seek(event.mono, {
      selection: { kind: "event", id: event.id },
      announcement: announcement ?? describe(event, archive)
    });
  };

  const announceNoMore = (what: "errorsWord" | "eventsWord" | "actionsWord"): void => {
    const messages = i18n();
    update({ announcement: messages.tn("announceNoMore", { what: messages.tn(what) }) });
  };

  const applyPendingHash = (archive: LoadedArchive): Partial<PlayerState> => {
    const hash = pendingHash;
    pendingHash = null;
    const patch: Partial<PlayerState> = {
      playheadMono: archive.model.minMono,
      selection: null,
      range: null,
      detailsOpen: false
    };

    if (!hash) {
      return patch;
    }

    if (hash.offsetMs !== undefined) {
      patch.playheadMono = clampMono(archive.model.minMono + hash.offsetMs, bounds(archive));
    }

    if (hash.selection && selectionExists(archive, hash.selection)) {
      patch.selection = hash.selection;
    }

    if (hash.tab) {
      patch.tab = hash.tab;
    }

    return patch;
  };

  const requestPassphrase = (request: PassphraseRequest, token: number): Promise<string | null> =>
    new Promise((resolve) => {
      if (token !== loadToken) {
        resolve(null);
        return;
      }

      pendingPassphrase?.(null);
      pendingPassphrase = resolve;
      update({
        status: {
          phase: "passphrase",
          fileName: request.fileName,
          invalid: request.reason === "invalid"
        }
      });
    });

  return {
    store,

    /** Opens an archive file; encrypted archives go through the passphrase dialog. */
    async openFile(source: ArchiveSource): Promise<void> {
      const fileName = source.name;
      // The newest file wins: an older load still waiting for its passphrase is cancelled.
      const token = ++loadToken;
      pendingPassphrase?.(null);
      pendingPassphrase = null;

      if (!ARCHIVE_NAME_PATTERN.test(fileName)) {
        update({
          status: { phase: "error", fileName, message: i18n().tn("unsupportedFile") },
          announcement: i18n().tn("unsupportedFile")
        });
        return;
      }

      pause();
      update({ status: { phase: "loading", fileName }, dragActive: false });

      try {
        const bytes = new Uint8Array(await source.arrayBuffer());
        const player = await openArchiveWithPassphrase(bytes, {
          fileName,
          open: options.open,
          requestPassphrase: (request) => requestPassphrase(request, token)
        });

        if (token !== loadToken) {
          return;
        }

        const messages = i18n();
        const model = buildArchiveModel(player, {
          pointerReasonClick: messages.messages.pointerReasonActionClick,
          pointerReasonMove: messages.messages.pointerReasonMove,
          formatPointerKind: messages.formatPointerKind
        });
        const archive: LoadedArchive = {
          fileName,
          player,
          model,
          view: buildSessionView(player.archive, model),
          bytes
        };

        mediaCache.clear();
        update({
          ...applyPendingHash(archive),
          archive,
          status: { phase: "ready" },
          isPlaying: false,
          announcement: messages.tn("archiveLoaded", { fileName })
        });
      } catch (error) {
        if (token !== loadToken) {
          return;
        }

        if (error instanceof OpenArchiveError && error.code === "passphrase-cancelled") {
          update({
            status: store.getState().archive ? { phase: "ready" } : { phase: "empty" }
          });
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        update({
          status: { phase: "error", fileName, message },
          announcement: i18n().tn("loadFailed", { fileName, error: message })
        });
      } finally {
        if (token === loadToken) {
          pendingPassphrase = null;
        }
      }
    },

    submitPassphrase(passphrase: string): void {
      const resolve = pendingPassphrase;
      pendingPassphrase = null;
      const status = store.getState().status;

      if (status.phase === "passphrase") {
        update({ status: { phase: "loading", fileName: status.fileName } });
      }

      resolve?.(passphrase);
    },

    cancelPassphrase(): void {
      const resolve = pendingPassphrase;
      pendingPassphrase = null;
      resolve?.(null);
    },

    dismissError(): void {
      update({ status: store.getState().archive ? { phase: "ready" } : { phase: "empty" } });
    },

    play(): void {
      const state = store.getState();
      const archive = state.archive;

      if (!archive || state.isPlaying) {
        return;
      }

      update({
        isPlaying: true,
        playheadMono: resolvePlayStart(state.playheadMono, bounds(archive))
      });
      loop.start();
    },

    pause,

    togglePlay(): void {
      if (store.getState().isPlaying) {
        pause();
        return;
      }

      this.play();
    },

    /** Moves the playhead (and pauses), like dragging the scrubber. */
    seek(mono: number): void {
      seek(mono);
    },

    seekBy(step: SeekStep, direction: Direction): void {
      seek(store.getState().playheadMono + SEEK_STEP_MS[step] * direction);
    },

    seekEdge(edge: "start" | "end"): void {
      const archive = store.getState().archive;

      if (archive) {
        seek(edge === "start" ? archive.model.minMono : archive.model.maxMono);
      }
    },

    setRate(rate: number): void {
      if (Number.isFinite(rate) && rate > 0) {
        update({ rate });
      }
    },

    setSkipIdle(skipIdle: boolean): void {
      update({ skipIdle });
    },

    setFollow(follow: boolean): void {
      update({ follow });
    },

    /** Selects an object and moves the playhead to it (PROPOSAL §3: one selection, time + object). */
    select(selection: Selection): void {
      const archive = store.getState().archive;
      const mono = archive ? resolveSelectionMono(archive, selection) : null;

      if (mono === null) {
        return;
      }

      seek(mono, { selection });
    },

    selectEvent,

    clearSelection(): void {
      update({ selection: null, detailsOpen: false });
    },

    /** J / L in the current list: the active rail tab's rows, else the Activity events. */
    stepList(direction: Direction): void {
      const state = store.getState();
      const archive = state.archive;

      if (!archive) {
        return;
      }

      const items =
        options.stepItems?.(state) ??
        selectActivityEvents(archive, state.query).map(
          (event): ListStepItem => ({
            selection: { kind: "event", id: event.id },
            mono: event.mono
          })
        );
      const selectedKey = state.selection ? stepKey(state.selection) : null;
      const selectedEventId = resolveSelectedEventId(archive, state.selection);
      const next = stepInList(items, {
        pickId: (item) => stepKey(item.selection),
        pickMono: (item) => item.mono,
        // A selection that is not a row of this list (e.g. a request picked on the timeline)
        // still counts when its event is a row.
        selectedId: items.some((item) => stepKey(item.selection) === selectedKey)
          ? selectedKey
          : selectedEventId
            ? stepKey({ kind: "event", id: selectedEventId })
            : null,
        playheadMono: state.playheadMono,
        direction
      });

      if (!next) {
        announceNoMore("eventsWord");
        return;
      }

      const event =
        next.selection.kind === "event"
          ? archive.model.eventById.get(next.selection.id)
          : undefined;

      if (event) {
        selectEvent(event);
      } else {
        this.select(next.selection);
      }
    },

    /** E / Shift+E. */
    stepError(direction: Direction): void {
      const state = store.getState();
      const archive = state.archive;

      if (!archive) {
        return;
      }

      const errors = archive.view.errorEvents;
      const next = findByTime(errors, (event) => event.mono, state.playheadMono, direction);

      if (!next) {
        announceNoMore("errorsWord");
        return;
      }

      const time = formatOffset(next.mono - archive.model.minMono, state.locale);
      const label = compactText(`${next.type} ${readEventSummaryText(next)}`, ANNOUNCE_LABEL_MAX);
      selectEvent(
        next,
        i18n().tn("announceError", {
          index: errors.indexOf(next) + 1,
          count: errors.length,
          label,
          time
        })
      );
    },

    /** A: the next user action; its trigger event becomes the selection. */
    nextAction(): void {
      const state = store.getState();
      const archive = state.archive;

      if (!archive) {
        return;
      }

      const action = findByTime(
        archive.model.actionTimeline,
        (entry) => entry.startMono,
        state.playheadMono,
        1
      );
      const trigger = action ? archive.model.eventById.get(action.triggerEventId) : undefined;

      if (trigger) {
        selectEvent(trigger);
      } else {
        announceNoMore("actionsWord");
      }
    },

    /** The timeline range (Shift+drag); `null` clears it. Kept inside the recording. */
    setRange(range: TimeRange | null): void {
      const state = store.getState();
      const archive = state.archive;
      const next =
        archive && range ? normalizeRange(range.startMono, range.endMono, bounds(archive)) : null;

      if (!isSameRange(state.range, next)) {
        update({ range: next });
      }
    },

    clearRange(): void {
      if (store.getState().range) {
        update({ range: null });
      }
    },

    /** `[` / `]`: moves the range start / end to the playhead (starts a range if none). */
    markRange(edge: "start" | "end"): void {
      const state = store.getState();
      const archive = state.archive;

      if (!archive) {
        return;
      }

      const next = moveRangeEdge(state.range, edge, state.playheadMono, bounds(archive));

      if (!isSameRange(state.range, next)) {
        const { minMono } = archive.model;
        update({
          range: next,
          announcement: next
            ? i18n().tn("rangeAnnounce", {
                range: `${formatClock(next.startMono - minMono, state.locale)} – ${formatClock(
                  next.endMono - minMono,
                  state.locale
                )}`
              })
            : state.announcement
        });
      }
    },

    setLanesExpanded(lanesExpanded: boolean): void {
      update({ lanesExpanded });
    },

    setTab(tab: RailTab): void {
      update({ tab });
    },

    setQuery(query: string): void {
      update({ query });
    },

    openDetails(): void {
      if (store.getState().selection) {
        update({ detailsOpen: true });
      }
    },

    /** Esc: closes the topmost layer (shortcut sheet, then details). */
    close(): void {
      const state = store.getState();

      if (state.shortcutsOpen) {
        update({ shortcutsOpen: false });
      } else if (state.detailsOpen) {
        update({ detailsOpen: false });
      } else if (state.railWide) {
        update({ railWide: false });
      }
    },

    /** F: the rail takes the whole width, or gives the stage its column back. */
    toggleRailWide(): void {
      update({ railWide: !store.getState().railWide });
    },

    setShortcutsOpen(shortcutsOpen: boolean): void {
      update({ shortcutsOpen });
    },

    setArchiveInfoOpen(archiveInfoOpen: boolean): void {
      update({ archiveInfoOpen: archiveInfoOpen && store.getState().archive !== null });
    },

    /** "Reset layout": the splitters return to their default sizes (stored sizes are dropped). */
    resetLayout(): void {
      store.setState((state) => ({ ...state, layoutRevision: state.layoutRevision + 1 }));
    },

    setDragActive(dragActive: boolean): void {
      if (store.getState().dragActive !== dragActive) {
        update({ dragActive });
      }
    },

    /** Switches the language in place: no reload; archive, playhead and selection stay. */
    setLocale(locale: PlayerLocale): void {
      if (store.getState().locale === locale) {
        return;
      }

      persistLocale(locale);
      applyPlayerDocumentLocale(locale);
      update({ locale });
    },

    setTheme(theme: ThemePreference): void {
      persistTheme(theme);
      update({ theme });
    },

    /** State from the URL hash: applied now, or when the next archive finishes loading. */
    applyHash(hash: HashState): void {
      const archive = store.getState().archive;

      if (!archive) {
        pendingHash = hash;
        return;
      }

      const patch: Partial<PlayerState> = {};

      if (hash.offsetMs !== undefined) {
        patch.playheadMono = clampMono(archive.model.minMono + hash.offsetMs, bounds(archive));
      }

      if (hash.selection && selectionExists(archive, hash.selection)) {
        patch.selection = hash.selection;
      }

      if (hash.tab) {
        patch.tab = hash.tab;
      }

      // An in-page anchor or a cleared hash carries no player state.
      if (Object.keys(patch).length === 0) {
        return;
      }

      pause();
      update(patch);
    },

    /** Object URL of a screenshot blob, or `null` when the archive does not have it. */
    loadScreenshotUrl(shotId: string): Promise<string | null> {
      const player = store.getState().archive?.player;

      if (!player) {
        return Promise.resolve(null);
      }

      return mediaCache
        .get(`shot:${shotId}`, async () => {
          const blob = await player.getBlob(shotId);
          return blob ? { parts: [copyBytes(blob.bytes)], mime: blob.mime } : null;
        })
        .then((url) => (url && isReplayResourceAllowedByDefault(url) ? url : null));
    },

    /** Object URL of a tab recording assembled from its chunks. */
    loadRecordingUrl(recording: ScreenRecordingRecord): Promise<string | null> {
      const player = store.getState().archive?.player;

      if (!player) {
        return Promise.resolve(null);
      }

      return mediaCache
        .get(`rec:${recording.recordingId}`, async () => {
          const parts: Uint8Array<ArrayBuffer>[] = [];
          let mime = recording.mime;

          for (const chunk of recording.chunks) {
            const blob = await player.getBlob(chunk);

            if (!blob) {
              return null;
            }

            mime = mime || blob.mime;
            parts.push(copyBytes(blob.bytes));
          }

          return { parts, mime: mime || "video/webm" };
        })
        .then((url) => (url && isReplayResourceAllowedByDefault(url) ? url : null));
    },

    dispose(): void {
      loop.stop();
      mediaCache.clear();
      pendingPassphrase?.(null);
      pendingPassphrase = null;
    }
  };
}

export type PlayerController = ReturnType<typeof createPlayerController>;

function stepKey(selection: Selection): string {
  return `${selection.kind}:${selection.id}`;
}

function selectionExists(archive: LoadedArchive, selection: Selection): boolean {
  return resolveSelectionMono(archive, selection) !== null;
}

/**
 * The event row that stands for the selection: the event itself, the request's `network.request`
 * (or first) event, or the action's trigger.
 */
export function resolveSelectedEventId(
  archive: LoadedArchive,
  selection: Selection | null
): string | null {
  if (!selection) {
    return null;
  }

  const { model } = archive;

  if (selection.kind === "event") {
    return selection.id;
  }

  if (selection.kind === "request") {
    const ids = model.waterfallByReqId.get(selection.id)?.eventIds ?? [];
    return ids.find((id) => model.eventById.get(id)?.type === "network.request") ?? ids[0] ?? null;
  }

  return (
    model.actionTimeline.find((action) => action.actId === selection.id)?.triggerEventId ?? null
  );
}

/** Time of the selected object: the event, the request start or the action start. */
export function resolveSelectionMono(archive: LoadedArchive, selection: Selection): number | null {
  const { model } = archive;

  if (selection.kind === "event") {
    return model.eventById.get(selection.id)?.mono ?? null;
  }

  if (selection.kind === "request") {
    return model.waterfallByReqId.get(selection.id)?.startMono ?? null;
  }

  return model.actionTimeline.find((action) => action.actId === selection.id)?.startMono ?? null;
}
