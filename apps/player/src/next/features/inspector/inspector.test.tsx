/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { NetworkWaterfallEntry } from "@webblackbox/player-sdk";
import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createPlainArchive } from "../../../../scripts/lib/synthetic-session.mjs";
import { createMediaUrlCache } from "../../../core/media-cache.js";
import { createPlayerI18n, type PlayerLocale } from "../../../lib/i18n.js";
import { App } from "../../app.js";
import { createPlayerController } from "../../controller.js";
import { createInitialState, type LoadedArchive, type PlayerState } from "../../state.js";
import { createStore } from "../../store.js";
import { generateSlice } from "../generate/api.js";
import { loadSyntheticArchive } from "../test-archive.js";
import { INSPECTION_CACHE_SIZE, inspectSelection, type Inspection } from "./inspector-model.js";
import { describeInspection, shortPath } from "./inspector-text.js";
import { inspectorMessages, type InspectorTranslate } from "./messages.js";
import { placeTarget, selectTargetFrame } from "./target-frame.js";

/** The lobby click's one successful request (`GET …/game/64`). */
const LOBBY_OK_REQUEST = "90080.1700";

let archiveBytes: Uint8Array;
let archive: LoadedArchive;

beforeAll(async () => {
  archiveBytes = await createPlainArchive();
  archive = await loadSyntheticArchive();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.location.hash = "";
});

function lobbyClick(): WebBlackboxEvent {
  const event = archive.model.events.find(
    (candidate) => candidate.type === "user.click" && candidate.ref?.act === "A-000002"
  );

  if (!event) {
    throw new Error("The synthetic archive has no lobby click.");
  }

  return event;
}

function lobbyInspection(): Inspection {
  const inspection = inspectSelection(archive, { kind: "event", id: lobbyClick().id });

  if (!inspection) {
    throw new Error("No inspection");
  }

  return inspection;
}

function translate(locale: PlayerLocale): InspectorTranslate {
  return (key, values) => inspectorMessages.translate(locale, key, values);
}

describe("inspector model", () => {
  it("reads the click's target, what it caused and its Playwright step", () => {
    const click = lobbyClick();
    const inspection = inspectSelection(archive, { kind: "event", id: click.id });

    expect(inspection).toMatchObject({
      isTrigger: true,
      actionLabel: "A-2",
      target: {
        selector: "#lobbyGame_64 picture > img",
        text: "Live table 64",
        rect: { x: 324, y: 382, width: 120, height: 36 }
      },
      phrase: { verb: "click", target: "Live table 64", route: "#/lobby" }
    });
    // Every request of the action, not the action timeline's first five.
    expect(inspection?.consequences).toMatchObject({ requests: 6, failedRequests: 5 });
    expect(inspection?.consequences?.items[0]).toMatchObject({ kind: "request", status: 401 });
    expect(
      inspection?.consequences?.items.find((item) => item.label.includes("/chats/"))
    ).toMatchObject({ status: 401, count: 3 });
    expect(inspection?.playwrightStep.join("\n")).toContain("#lobbyGame_64 picture > img");
    expect(inspection?.playwrightRange.endMono).toBeGreaterThan(click.mono);
    expect(inspection?.playwrightRange.startMono).toBeLessThanOrEqual(click.mono);
    // Memoized per archive and event.
    expect(inspectSelection(archive, { kind: "action", id: "A-000002" })).toBe(inspection);
  });

  it("counts the requests of an action the SDK inferred (a trigger without ref.act)", () => {
    const derived = archive.model.actionTimeline.find(
      (action) => action.actId.startsWith("derived:") && action.requests.length > 0
    );

    if (!derived) {
      throw new Error("the synthetic archive has no inferred action with requests");
    }

    const inspection = inspectSelection(archive, { kind: "event", id: derived.triggerEventId });
    expect(inspection?.isTrigger).toBe(true);
    expect(inspection?.consequences?.requests).toBeGreaterThanOrEqual(derived.requests.length);
  });

  it("words the summary in the reader's language", () => {
    const inspection = inspectSelection(archive, { kind: "event", id: lobbyClick().id });

    if (!inspection) {
      throw new Error("No inspection");
    }

    const en = describeInspection(inspection, translate("en"), createPlayerI18n("en"));
    expect(en.sentence).toBe("The user clicked “Live table 64” on #/lobby.");
    expect(en.outcome).toMatch(/^5 of 6 requests failed; the first, 401 GET .+, came .+ later\.$/);

    const ru = describeInspection(inspection, translate("ru"), createPlayerI18n("ru"));
    expect(ru.sentence).toBe("Пользователь нажал на «Live table 64» на #/lobby.");
    expect(ru.outcome).toMatch(/^Запросов с ошибкой: 5 из 6; первый — 401 GET/);
  });

  it("names the failed requests when an error came before them", () => {
    const inspection = lobbyInspection();
    const consequences = inspection.consequences;

    if (!consequences?.firstFailedRequest) {
      throw new Error("No failed request");
    }

    const errorFirst: Inspection = {
      ...inspection,
      consequences: {
        ...consequences,
        consoleErrors: 1,
        firstFailure: {
          ...consequences.firstFailedRequest,
          kind: "console-error",
          label: "AuthError",
          offsetMs: 1,
          reqId: null
        }
      }
    };
    const { outcome } = describeInspection(errorFirst, translate("en"), createPlayerI18n("en"));

    expect(outcome).toMatch(/^5 of 6 requests failed; the first, 401 GET /);
  });

  it("words request counts with the plural form of the locale", () => {
    const inspection = lobbyInspection();
    const outcome = (locale: PlayerLocale, requests: number, failedRequests = 0): string => {
      const consequences = inspection.consequences;

      if (!consequences) {
        throw new Error("No consequences");
      }

      const counted: Inspection = {
        ...inspection,
        consequences: {
          ...consequences,
          requests,
          failedRequests,
          consoleErrors: 0,
          exceptions: 0,
          firstFailure: failedRequests > 0 ? consequences.firstFailedRequest : null,
          firstFailedRequest: failedRequests > 0 ? consequences.firstFailedRequest : null
        }
      };
      return describeInspection(counted, translate(locale), createPlayerI18n(locale)).outcome;
    };

    expect(outcome("en", 1)).toBe("1 request succeeded.");
    expect(outcome("en", 4)).toBe("All 4 requests succeeded.");
    expect(outcome("en", 1, 1)).toMatch(/^1 of 1 request failed: 401 GET .+, .+ later\.$/);
    expect(outcome("ru", 1)).toBe("1 запрос выполнен успешно.");
    expect(outcome("ru", 21)).toBe("21 запрос выполнен успешно.");
    expect(outcome("ru", 3)).toBe("3 запроса выполнены успешно.");
    expect(outcome("ru", 5)).toBe("Все 5 запросов выполнены успешно.");
    expect(outcome("zh-CN", 1)).toBe("1 个请求成功。");
    expect(outcome("zh-CN", 7)).toBe("全部 7 个请求均成功。");
  });

  it("does not count cancelled requests as failures", () => {
    const withEntry = (patch: Partial<NetworkWaterfallEntry>): LoadedArchive => {
      const waterfallByReqId = new Map(archive.model.waterfallByReqId);
      const entry = waterfallByReqId.get(LOBBY_OK_REQUEST);

      if (!entry) {
        throw new Error("No lobby request");
      }

      waterfallByReqId.set(LOBBY_OK_REQUEST, { ...entry, ...patch });
      return { ...archive, model: { ...archive.model, waterfallByReqId } };
    };
    const select = { kind: "event", id: lobbyClick().id } as const;
    const cancelled = withEntry({ status: undefined, failed: true, errorText: "net::ERR_ABORTED" });
    const reset = withEntry({
      status: undefined,
      failed: true,
      errorText: "net::ERR_CONNECTION_RESET"
    });

    expect(inspectSelection(cancelled, select)?.consequences).toMatchObject({
      requests: 6,
      failedRequests: 5
    });
    expect(inspectSelection(reset, select)?.consequences).toMatchObject({
      requests: 6,
      failedRequests: 6
    });
  });

  it("names the route the action happened on, not the merged chapter strip label", () => {
    const click = lobbyClick();
    const lobbyPush = archive.model.events.find(
      (event) => event.type === "nav.history.push" && JSON.stringify(event.data).includes("#/lobby")
    );
    // The chapter strip merges narrow chapters and marks reloads; the summary must not read it.
    const merged: LoadedArchive = {
      ...archive,
      view: {
        ...archive.view,
        chapters: [
          {
            startMono: archive.model.minMono,
            endMono: archive.model.maxMono,
            label: "↻ #/ → #/error → #/lobby …",
            kind: "reload",
            isErrorRoute: true
          }
        ]
      }
    };
    const inspection = inspectSelection(merged, { kind: "event", id: click.id });

    expect(inspection?.phrase.route).toBe("#/lobby");
    expect(inspection?.playwrightRange.startMono).toBe(lobbyPush?.mono);
  });

  it("finds the reaction of a click re-timed to wall clock by its capture mono", () => {
    const click = lobbyClick();
    const retimed = { ...click, mono: click.mono + 5_000_000 };
    const probe = {
      ...click,
      id: "E-reaction",
      type: "user.click.reaction",
      mono: retimed.mono + 20,
      data: { clickMono: click.mono, mutated: true, latencyMs: 12, windowMs: 1_000 }
    } as WebBlackboxEvent;
    const eventById = new Map(archive.model.eventById);
    eventById.set(click.id, retimed);
    eventById.set(probe.id, probe);
    // `archive.player.events` keep the capture monos; the model holds the re-timed ones.
    const retimedArchive: LoadedArchive = {
      ...archive,
      model: { ...archive.model, eventById, events: [...archive.model.events, probe] }
    };

    expect(inspectSelection(retimedArchive, { kind: "event", id: click.id })?.reaction).toEqual({
      mutated: true,
      latencyMs: 12,
      windowMs: 1_000
    });
  });

  it("keeps a bounded number of inspections per archive", () => {
    const copy: LoadedArchive = { ...archive };
    const first = inspectSelection(copy, { kind: "event", id: archive.model.events[0]?.id ?? "" });

    for (const event of archive.model.events.slice(1, INSPECTION_CACHE_SIZE + 1)) {
      inspectSelection(copy, { kind: "event", id: event.id });
    }

    const again = inspectSelection(copy, { kind: "event", id: archive.model.events[0]?.id ?? "" });
    expect(again).not.toBe(first);
    expect(again).toEqual(first);
  });

  it("has no inspection for a missing selection", () => {
    expect(inspectSelection(archive, null)).toBeNull();
    expect(inspectSelection(archive, { kind: "event", id: "missing" })).toBeNull();
  });

  it("shortens long paths from the start", () => {
    expect(shortPath("https://a.test/gw/bff/users/api/v1.0/casino-user?x=1", 24)).toBe(
      "…/api/v1.0/casino-user"
    );
    expect(shortPath("https://a.test/#/lobby")).toBe("/#/lobby");
  });

  it("outlines the target on the video only while the inspector is open at that moment", () => {
    const click = lobbyClick();
    const state: PlayerState = {
      ...createInitialState("en", "light"),
      archive,
      selection: { kind: "event", id: click.id },
      playheadMono: click.mono + 100,
      detailsOpen: true
    };

    expect(selectTargetFrame(state)).toMatchObject({ x: 324, y: 382, width: 120, height: 36 });
    expect(selectTargetFrame({ ...state, detailsOpen: false })).toBeNull();
    expect(selectTargetFrame({ ...state, playheadMono: click.mono + 10_000 })).toBeNull();
    // The inspector replaces the Activity list only: another rail tab hides it.
    expect(selectTargetFrame({ ...state, tab: "network" })).toBeNull();
  });

  it("moves an iframe target by the frame offset and skips frames without one", () => {
    const click = lobbyClick();
    const inFrame = (data: Record<string, unknown>): PlayerState => {
      const eventById = new Map(archive.model.eventById);
      eventById.set(click.id, {
        ...click,
        frame: "content-iframe",
        data: { ...(click.data as Record<string, unknown>), ...data }
      } as WebBlackboxEvent);
      return {
        ...createInitialState("en", "light"),
        archive: { ...archive, model: { ...archive.model, eventById } },
        selection: { kind: "event", id: click.id },
        playheadMono: click.mono,
        detailsOpen: true
      };
    };
    const topViewport = (click.data as { viewport: { w: number; h: number } }).viewport;

    expect(
      selectTargetFrame(inFrame({ frameOffset: { x: 0, y: 0 }, viewport: { w: 300, h: 150 } }))
    ).toEqual({
      x: 324,
      y: 382,
      width: 120,
      height: 36,
      // The frame's own viewport is not the video's: the top one comes from the page's events.
      viewportWidth: topViewport.w,
      viewportHeight: topViewport.h
    });
    expect(selectTargetFrame(inFrame({ frameOffset: { x: 10, y: 20 } }))).toMatchObject({
      x: 334,
      y: 402
    });

    const crossOrigin = inFrame({});
    expect(selectTargetFrame(crossOrigin)).toBeNull();
    const inspection = crossOrigin.archive
      ? inspectSelection(crossOrigin.archive, crossOrigin.selection)
      : null;
    expect(inspection && placeTarget(inspection)).toBeNull();
  });
});

async function renderPlayer(locale: PlayerLocale = "en") {
  const store = createStore<PlayerState>(createInitialState(locale, "light"));
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

describe("InspectorPanel", () => {
  it("replaces the Activity list, opens generators and goes back", async () => {
    const { store, controller } = await renderPlayer();
    const click = store.getState().archive?.model.eventById.get(lobbyClick().id);

    if (!click) {
      throw new Error("No click");
    }

    act(() => {
      controller.selectEvent(click);
      controller.openDetails();
    });

    const inspector = await screen.findByTestId("inspector");
    expect(screen.queryByTestId("event-list")).not.toBeInTheDocument();
    expect(within(inspector).getByTestId("inspector-title")).toHaveTextContent("Live table 64");
    expect(within(inspector).getByTestId("inspector-meta")).toHaveTextContent(
      "user.click · 10.77 · action A-2"
    );
    expect(within(inspector).getByTestId("inspector-summary")).toHaveTextContent(
      "The user clicked “Live table 64” on #/lobby."
    );
    expect(within(inspector).getByTestId("inspector-selector")).toHaveTextContent(
      "#lobbyGame_64 picture > img"
    );
    const failedStat = within(inspector).getByTestId("inspector-stat-failed");
    // Label first for screen readers; the number is shown above it.
    expect(failedStat.firstElementChild?.tagName).toBe("DT");
    expect(failedStat.querySelector("dd")).toHaveTextContent("5");
    expect(
      within(inspector).getByTestId("inspector-stat-requests").querySelector("dd")
    ).toHaveTextContent("6");
    expect(within(inspector).getByTestId("inspector-box")).toHaveTextContent(
      "outlined on the video"
    );
    const chats = within(inspector)
      .getAllByTestId("inspector-consequence")
      .find((item) => item.textContent?.includes("chats"));
    expect(chats).toHaveTextContent("failed");
    expect(chats).toHaveTextContent("repeated 3 times");
    expect(within(inspector).getAllByTestId("inspector-consequence").length).toBeGreaterThan(0);
    expect(document.activeElement).toBe(inspector);

    fireEvent.click(within(inspector).getByTestId("inspector-playwright"));
    expect(generateSlice.select(store.getState()).request).toMatchObject({
      kind: "playwright",
      range: { endMono: expect.any(Number) }
    });

    fireEvent.click(within(inspector).getByTestId("inspector-bug-report"));
    expect(generateSlice.select(store.getState()).request?.kind).toBe("bug-report");

    act(() => controller.setLocale("ru"));
    expect(within(inspector).getByTestId("inspector-summary")).toHaveTextContent(
      "Пользователь нажал на «Live table 64» на #/lobby."
    );

    fireEvent.click(within(inspector).getByTestId("inspector-back"));
    expect(screen.queryByTestId("inspector")).not.toBeInTheDocument();
    expect(screen.getByTestId("event-list")).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByTestId("event-list"));
    expect(store.getState().selection).toEqual({ kind: "event", id: click.id });
  });

  it("offers the request of a request event in the Network tab", async () => {
    const { store, controller } = await renderPlayer();
    const requestEvent = store
      .getState()
      .archive?.model.events.find(
        (event) => event.type === "network.response" && event.ref?.req === "90080.1706"
      );

    if (!requestEvent) {
      throw new Error("No request event");
    }

    act(() => {
      controller.selectEvent(requestEvent);
      controller.openDetails();
    });

    const inspector = await screen.findByTestId("inspector");
    expect(within(inspector).getByTestId("inspector-request")).toHaveTextContent("casino-user");

    fireEvent.click(within(inspector).getByTestId("inspector-open-request"));
    expect(store.getState().tab).toBe("network");
    expect(store.getState().selection).toEqual({ kind: "request", id: "90080.1706" });
  });

  it("opens from the selected row's Inspect button", async () => {
    const { controller } = await renderPlayer();

    // jsdom does not scroll the virtual list: pick a row of its first window.
    const rowId = screen.getAllByTestId("event-row")[1]?.dataset.eventId ?? "";
    const event = controller.store.getState().archive?.model.eventById.get(rowId);

    if (!event) {
      throw new Error("No rendered row");
    }

    act(() => controller.selectEvent(event));
    fireEvent.click(await screen.findByTestId("row-inspect"));
    expect(await screen.findByTestId("inspector")).toBeInTheDocument();
  });
});
