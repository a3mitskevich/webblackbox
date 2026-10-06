/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
import { inspectSelection } from "./inspector-model.js";
import { describeInspection, shortPath } from "./inspector-text.js";
import { inspectorMessages, type InspectorTranslate } from "./messages.js";
import { selectTargetFrame } from "./target-frame.js";

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
    expect(inspection?.consequences?.failedRequests).toBeGreaterThanOrEqual(2);
    expect(inspection?.consequences?.items[0]).toMatchObject({ kind: "request", status: 401 });
    expect(inspection?.playwrightStep.join("\n")).toContain("#lobbyGame_64 picture > img");
    expect(inspection?.playwrightRange.endMono).toBeGreaterThan(click.mono);
    expect(inspection?.playwrightRange.startMono).toBeLessThanOrEqual(click.mono);
    // Memoized per archive and event.
    expect(inspectSelection(archive, { kind: "action", id: "A-000002" })).toBe(inspection);
  });

  it("words the summary in the reader's language", () => {
    const inspection = inspectSelection(archive, { kind: "event", id: lobbyClick().id });

    if (!inspection) {
      throw new Error("No inspection");
    }

    const en = describeInspection(inspection, translate("en"), createPlayerI18n("en"));
    expect(en.sentence).toBe("The user clicked “Live table 64” on #/lobby.");
    expect(en.outcome).toMatch(
      /^\d+ of \d+ requests failed; the first, 401 GET .+, came .+ later\.$/
    );

    const ru = describeInspection(inspection, translate("ru"), createPlayerI18n("ru"));
    expect(ru.sentence).toBe("Пользователь нажал на «Live table 64» на #/lobby.");
    expect(ru.outcome).toMatch(/^Запросов с ошибкой: \d+ из \d+; первый — 401 GET/);
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
    expect(within(inspector).getByTestId("inspector-stat-failed")).toHaveTextContent(/[1-9]/);
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
