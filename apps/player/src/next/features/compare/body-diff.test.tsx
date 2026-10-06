/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { NetworkWaterfallEntry, WebBlackboxPlayer } from "@webblackbox/player-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { createMediaUrlCache } from "../../../core/media-cache.js";
import { PlayerProvider } from "../../context.js";
import { createPlayerController } from "../../controller.js";
import { createInitialState, type PlayerState } from "../../state.js";
import { createStore } from "../../store.js";
import {
  BodyDiff,
  buildDiffLines,
  loadResponseBody,
  MAX_DIFF_BYTES,
  MAX_EDIT_LENGTH
} from "./body-diff.js";

afterEach(cleanup);

const encode = (text: string) => new TextEncoder().encode(text);

/** A player whose only blob is `bytes` (all BodyDiff reads). */
function playerWith(bytes: Uint8Array): WebBlackboxPlayer {
  return { getBlob: async () => ({ bytes }) } as unknown as WebBlackboxPlayer;
}

const entry = { responseBodyHash: "h", responseHeaders: {} } as unknown as NetworkWaterfallEntry;

function renderDiff(left: Uint8Array, right: Uint8Array) {
  const store = createStore<PlayerState>(createInitialState("en", "light"));
  const controller = createPlayerController(store, {
    scheduler: { request: () => 0, cancel: () => undefined },
    mediaCache: createMediaUrlCache({ createUrl: () => "blob:frame", revokeUrl: () => undefined })
  });
  render(
    <PlayerProvider controller={controller}>
      <BodyDiff
        id="diff-region"
        label="GET /api"
        left={{ player: playerWith(left), entry }}
        right={{ player: playerWith(right), entry }}
      />
    </PlayerProvider>
  );
}

const numbered = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index}`).join("\n");

describe("response body limits", () => {
  it("decodes only the first MAX_DIFF_BYTES and keeps a cut JSON raw", async () => {
    const json = JSON.stringify({ items: Array.from({ length: 40_000 }, (_, id) => ({ id })) });
    const body = await loadResponseBody(playerWith(encode(json)), entry);

    expect(body?.isCut).toBe(true);
    expect(body?.text.length).toBe(MAX_DIFF_BYTES);
    expect(body?.text.startsWith('{"items":[{"id":0}')).toBe(true);
    expect(await loadResponseBody(playerWith(encode("{}")), entry)).toEqual({
      text: "{}",
      isCut: false
    });
  });

  it("gives up on texts that differ in more lines than the edit limit", () => {
    expect(buildDiffLines(numbered(50, "a"), numbered(50, "b"), 10)).toBeNull();
    expect(buildDiffLines(numbered(50, "a"), numbered(50, "a"), 10)).not.toBeNull();
    expect(MAX_EDIT_LENGTH).toBeGreaterThan(0);
  });
});

describe("BodyDiff", () => {
  it("renders a long diff as a virtual list of a few rows", async () => {
    // Every third line changes: ~2000 diff rows, under the edit limit and not folded.
    const left = numbered(1500, "line");
    const right = left
      .split("\n")
      .map((line, index) => (index % 3 === 0 ? `${line} changed` : line))
      .join("\n");
    renderDiff(encode(left), encode(right));

    const diff = await screen.findByTestId("compare-body-diff");
    const rows = diff.querySelectorAll("[data-kind]");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(100);
    expect(diff.querySelector('[data-kind="del"]')).toHaveTextContent("line 0");
    expect(diff.querySelector('[data-kind="add"]')).toHaveTextContent("line 0 changed");
    expect(screen.getByRole("region", { name: "GET /api" })).toHaveAttribute("id", "diff-region");
  });

  it("says the bodies are too different instead of diffing them", async () => {
    const many = MAX_EDIT_LENGTH + 500;
    renderDiff(encode(numbered(many, "x")), encode(numbered(many, "y")));

    expect(await screen.findByTestId("compare-body-too-different")).toHaveTextContent(
      "differ too much"
    );
    expect(screen.queryByTestId("compare-body-diff")).toBeNull();
  });

  it("does not call cut bodies the same, and names the real limit", async () => {
    const prefix = "x".repeat(MAX_DIFF_BYTES);
    renderDiff(encode(`${prefix}\nA`), encode(`${prefix}\nB`));

    const same = await screen.findByTestId("compare-body-same");
    expect(same).toHaveTextContent("No difference in the first 256");
    expect(same).not.toHaveTextContent("The response bodies are the same");
  });

  it("notes the cut next to a diff of cut bodies", async () => {
    const tail = "y".repeat(MAX_DIFF_BYTES);
    renderDiff(encode(`left\n${tail}`), encode(`right\n${tail}`));

    await screen.findByTestId("compare-body-diff");
    expect(screen.getByTestId("compare-body-cut")).toHaveTextContent(
      /Only the first 256(\.0)? KB of each body/u
    );
  });
});
