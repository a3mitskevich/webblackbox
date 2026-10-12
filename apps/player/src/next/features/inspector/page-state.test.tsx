/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import type { DomA11ySnapshotData, WebBlackboxEvent } from "@webblackbox/protocol";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  buildSyntheticSession,
  createPlainArchive
} from "../../../../scripts/lib/synthetic-session.mjs";
import { createMediaUrlCache } from "../../../core/media-cache.js";
import { App } from "../../app.js";
import { createPlayerController } from "../../controller.js";
import { createInitialState, type LoadedArchive, type PlayerState } from "../../state.js";
import { createStore } from "../../store.js";
import { loadSyntheticArchive } from "../test-archive.js";
import { inspectSelection } from "./inspector-model.js";

const LOBBY_TREE = '- heading "Lobby" [level=1]\n- button "Live table 64" [focused]';
const ERROR_TREE = `${LOBBY_TREE}\n- alert: "Table unavailable"`;

let session: ReturnType<typeof buildSyntheticSession>;
let click: WebBlackboxEvent;
let archive: LoadedArchive;

/** The synthetic session with a snapshot after the lobby click and one at the end. */
function withSnapshots(): ReturnType<typeof buildSyntheticSession> {
  const base = buildSyntheticSession();
  const events = base.events as WebBlackboxEvent[];
  const lobbyClick = events.find(
    (event) => event.type === "user.click" && event.ref?.act === "A-000002"
  );

  if (!lobbyClick) {
    throw new Error("The synthetic archive has no lobby click.");
  }

  const snapshotEvent = (
    id: string,
    offset: number,
    tree: string,
    trigger: DomA11ySnapshotData["trigger"]
  ) =>
    ({
      ...lobbyClick,
      id,
      type: "dom.a11y.snapshot",
      t: lobbyClick.t + offset,
      mono: lobbyClick.mono + offset,
      data: {
        trigger,
        url: "https://app.example.test/#/lobby",
        viewport: { w: 1280, h: 720, scrollX: 0, scrollY: 0 },
        scope: "viewport",
        tree,
        nodeCount: tree.split("\n").length,
        omittedNodes: 0,
        truncated: false,
        masking: "masked",
        durationMs: 3
      } satisfies DomA11ySnapshotData
    }) as WebBlackboxEvent;
  const sorted = [
    ...events,
    snapshotEvent("E-a11y-1", 700, LOBBY_TREE, {
      kind: "action",
      eventId: lobbyClick.id,
      delayMs: 700
    }),
    snapshotEvent("E-a11y-2", 2_000, ERROR_TREE, { kind: "error" })
  ].sort((left, right) => left.mono - right.mono);

  return {
    ...base,
    events: sorted,
    manifest: { ...base.manifest, stats: { ...base.manifest.stats, eventCount: sorted.length } }
  };
}

beforeAll(async () => {
  session = withSnapshots();
  archive = await loadSyntheticArchive("synthetic.webblackbox", session);
  click = archive.model.events.find(
    (event) => event.type === "user.click" && event.ref?.act === "A-000002"
  )!;
});

afterEach(() => {
  cleanup();
});

describe("page state in the inspector", () => {
  it("shows the snapshot an event triggered, the state before others, and a snapshot itself", () => {
    expect(inspectSelection(archive, { kind: "event", id: click.id })?.pageState).toMatchObject({
      relation: "linked",
      snapshot: { eventId: "E-a11y-1", tree: LOBBY_TREE }
    });

    const later = archive.model.events.find(
      (event) => event.mono > click.mono + 1_000 && event.mono < click.mono + 2_000
    );
    expect(
      later && inspectSelection(archive, { kind: "event", id: later.id })?.pageState
    ).toMatchObject({
      relation: "before",
      snapshot: { eventId: "E-a11y-1" }
    });
    expect(inspectSelection(archive, { kind: "event", id: "E-a11y-2" })?.pageState).toMatchObject({
      relation: "self",
      snapshot: { tree: ERROR_TREE }
    });
    expect(
      inspectSelection(archive, { kind: "event", id: archive.model.events[0]!.id })?.pageState
    ).toBeNull();
  });

  it("renders the tree as text in the inspector", async () => {
    const store = createStore<PlayerState>(createInitialState("en", "light"));
    const controller = createPlayerController(store, {
      scheduler: { request: () => 0, cancel: () => undefined },
      mediaCache: createMediaUrlCache({ createUrl: () => "blob:frame", revokeUrl: () => undefined })
    });
    const bytes = await createPlainArchive(session);
    render(<App controller={controller} />);
    await act(async () => {
      await controller.openFile({
        name: "synthetic.webblackbox",
        arrayBuffer: async () => bytes.slice().buffer
      });
    });
    const loadedClick = store.getState().archive?.model.eventById.get(click.id);

    act(() => {
      controller.selectEvent(loadedClick!);
      controller.openDetails();
    });

    const section = await screen.findByTestId("inspector-page-state");
    expect(section).toHaveTextContent("What the page showed after this event (action snapshot).");
    expect(within(section).getByTestId("inspector-page-state-tree")).toHaveTextContent(
      '- button "Live table 64" [focused]'
    );
  });
});
