/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildSyntheticSession,
  createPlainArchive
} from "../../../scripts/lib/synthetic-session.mjs";
import { createMediaUrlCache } from "../../core/media-cache.js";
import { App } from "../app.js";
import { createPlayerController } from "../controller.js";
import { createInitialState, type PlayerState } from "../state.js";
import { createStore } from "../store.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

/** The synthetic session, recorded with "Full capture" downgraded to "Balanced". */
async function downgradedArchive(): Promise<Uint8Array> {
  const session = buildSyntheticSession();
  const events = session.events.map((event: WebBlackboxEvent) =>
    event.type === "meta.config"
      ? {
          ...event,
          data: {
            ...(event.data as Record<string, unknown>),
            profile: {
              id: "balanced",
              name: "Balanced",
              extended: false,
              downgradedFrom: { id: "full", name: "Full capture" }
            }
          }
        }
      : event
  );
  return createPlainArchive({ ...session, events });
}

async function renderWith(bytes: Uint8Array) {
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
  return { store, controller };
}

describe("About this recording", () => {
  it("opens from the session block and lists what the archive contains", async () => {
    await renderWith(await createPlainArchive());

    expect(screen.queryByTestId("profile-chip")).not.toBeInTheDocument();
    expect(screen.queryByTestId("profile-banners")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("session"));

    const dialog = await screen.findByTestId("archive-info");
    expect(within(dialog).getByRole("heading", { name: "About this recording" })).toBeVisible();
    expect(within(dialog).getByTestId("session-facts")).toHaveTextContent(
      "https://app.example.test"
    );
    expect(within(dialog).getByTestId("contents-network")).toHaveTextContent(/Requests: \d+/);
    expect(within(dialog).getByTestId("contents-realtime")).toHaveTextContent(/WebSocket frames/);
    expect(within(dialog).queryByTestId("no-playback-events")).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByTestId("archive-info-close"));
    expect(screen.queryByTestId("archive-info")).not.toBeInTheDocument();
  });

  it("shows a downgraded profile in the header and above the stage", async () => {
    await renderWith(await downgradedArchive());

    expect(screen.getByTestId("profile-chip")).toHaveTextContent("Balanced");
    expect(screen.getByTestId("profile-chip")).toHaveAttribute("data-warn", "true");
    expect(screen.getByTestId("profile-banner")).toHaveTextContent(
      "Recorded with Balanced instead of Full capture"
    );

    fireEvent.click(screen.getByTestId("profile-banner-details"));
    const dialog = await screen.findByTestId("archive-info");
    expect(within(dialog).getByTestId("profile-banner-line")).toHaveTextContent("Full capture");
    expect(within(dialog).getByTestId("session-facts")).toHaveTextContent("Balanced");
  });

  it("has a player menu with the version and the source link", async () => {
    const { store } = await renderWith(await createPlainArchive());

    fireEvent.click(screen.getByTestId("player-menu"));
    const popup = await screen.findByTestId("player-menu-popup");
    expect(within(popup).getByTestId("player-version")).toHaveTextContent(/^WebBlackbox Player /);
    expect(within(popup).getByTestId("menu-source")).toHaveAttribute(
      "href",
      "https://github.com/webllm/webblackbox"
    );

    fireEvent.click(within(popup).getByTestId("menu-about-recording"));
    expect(store.getState().archiveInfoOpen).toBe(true);
  });
});
