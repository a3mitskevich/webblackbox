/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { RRWEB_EVENT_SCHEMA, type WebBlackboxEvent } from "@webblackbox/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildSyntheticSession,
  createPlainArchive
} from "../../../../scripts/lib/synthetic-session.mjs";
import { createMediaUrlCache } from "../../../core/media-cache.js";
import { App } from "../../app.js";
import { createPlayerController } from "../../controller.js";
import { createInitialState, type PlayerState } from "../../state.js";
import { createStore } from "../../store.js";

/** The synthetic session plus an rrweb log: snapshot at +1 s, a click on node 7 at +2 s. */
async function archiveWithRrweb(): Promise<{ bytes: Uint8Array; clickMono: number }> {
  const session = buildSyntheticSession();
  const events: WebBlackboxEvent[] = session.events;
  const start = events[0]!.mono;
  const batch = (
    offset: number,
    rrwebEvents: Array<{ type: number; timestamp: number; data: unknown }>,
    id: string
  ): WebBlackboxEvent => ({
    v: 1,
    sid: events[0]!.sid,
    tab: 7,
    t: start + offset,
    mono: start + offset,
    type: "dom.rrweb.event",
    id,
    data: { schema: RRWEB_EVENT_SCHEMA, events: rrwebEvents }
  });
  const withRrweb = [
    ...events,
    batch(
      1_000,
      [
        {
          type: 4,
          timestamp: start + 1_000,
          data: { href: "https://app.example.test/", width: 800, height: 600 }
        },
        { type: 2, timestamp: start + 1_000, data: { node: { type: 0, id: 1, childNodes: [] } } }
      ],
      "E-rrweb-1"
    ),
    batch(
      2_000,
      [{ type: 3, timestamp: start + 2_000, data: { source: 2, type: 2, id: 7, x: 5, y: 6 } }],
      "E-rrweb-2"
    )
  ].sort((left, right) => left.mono - right.mono);
  const bytes = await createPlainArchive({
    ...session,
    events: withRrweb,
    manifest: {
      ...session.manifest,
      stats: { ...session.manifest.stats, eventCount: withRrweb.length }
    }
  });

  return { bytes, clickMono: start + 2_000 };
}

async function renderReplay(bytes: Uint8Array) {
  const store = createStore<PlayerState>(createInitialState("en", "light"));
  const controller = createPlayerController(store, {
    scheduler: { request: () => 0, cancel: () => undefined },
    mediaCache: createMediaUrlCache({ createUrl: () => "blob:frame", revokeUrl: () => undefined })
  });
  render(<App controller={controller} />);
  await act(async () => {
    await controller.openFile({
      name: "synthetic.webblackbox",
      arrayBuffer: async () => bytes.slice().buffer
    });
  });
  act(() => controller.setTab("replay"));
  return { store, controller };
}

function fromFrame(frame: HTMLIFrameElement, data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data, source: frame.contentWindow }));
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.location.hash = "";
});

describe("DOM replay panel", () => {
  it("explains how to record a DOM log when the archive has none", async () => {
    await renderReplay(await createPlainArchive());

    expect(await screen.findByTestId("replay-empty")).toHaveTextContent("WB_SPIKE_RRWEB=1");
  });

  it("drives the sandboxed frame and shows the click target it reports", async () => {
    const { bytes, clickMono } = await archiveWithRrweb();
    const { store } = await renderReplay(bytes);
    const frame = (await screen.findByTestId("replay-frame")) as HTMLIFrameElement;

    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).toHaveAttribute("src", "./replay/index.html");

    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    await act(async () => {
      fromFrame(frame, { type: "wb-replay/ready" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const load = post.mock.calls.find(([message]) => message.type === "wb-replay/load");
    expect(load?.[0].events).toHaveLength(3);
    expect(load?.[1]).toBe("*");

    // Replies from any other window are ignored.
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "wb-replay/error", message: "spoofed" },
          source: window
        })
      );
      fromFrame(frame, {
        type: "wb-replay/loaded",
        eventCount: 3,
        resolvedResources: 0,
        unresolvedUrls: []
      });
    });
    expect(screen.queryByTestId("replay-error")).not.toBeInTheDocument();
    expect(screen.getByTestId("replay-status")).toHaveAttribute("data-events", "3");

    act(() => screen.getByTestId("replay-click").click());
    const seek = post.mock.calls.filter(([message]) => message.type === "wb-replay/seek").at(-1);
    expect(seek?.[0]).toMatchObject({ highlightNodeId: 7 });
    expect(store.getState().playheadMono).toBe(clickMono);

    act(() => {
      fromFrame(frame, {
        type: "wb-replay/highlight",
        nodeId: 7,
        found: true,
        tagName: "BUTTON",
        rect: { x: 10, y: 20, width: 30, height: 40 }
      });
    });
    expect(screen.getByTestId("replay-highlight")).toHaveTextContent("<button> at 10, 20 (30×40)");
  });
});
