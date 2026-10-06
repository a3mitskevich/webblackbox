/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { EndpointAlignment } from "@webblackbox/player-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMediaUrlCache } from "../../../core/media-cache.js";
import { PlayerProvider } from "../../context.js";
import { createPlayerController } from "../../controller.js";
import { createInitialState, type PlayerState } from "../../state.js";
import { createStore } from "../../store.js";
import { EndpointTable, MAX_ENDPOINT_ROWS } from "./endpoint-table.js";
import { compareMessages } from "./messages.js";

afterEach(cleanup);

function alignment(count: number): EndpointAlignment[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `GET /api/${index}`,
    left: null,
    right: {
      key: `GET /api/${index}`,
      method: "GET",
      path: `/api/${index}`,
      count: 1,
      failureCount: 0,
      p95Ms: 10,
      firstStartMono: 0,
      firstReqId: `r${index}`
    },
    signal: "new"
  }));
}

function renderTable(rows: EndpointAlignment[], selectedKey: string | null = null) {
  const store = createStore<PlayerState>(createInitialState("en", "light"));
  const controller = createPlayerController(store, {
    scheduler: { request: () => 0, cancel: () => undefined },
    mediaCache: createMediaUrlCache({ createUrl: () => "blob:frame", revokeUrl: () => undefined })
  });
  const t = (key: Parameters<typeof compareMessages.translate>[1], values?: object) =>
    compareMessages.translate("en", key, values as Record<string, string | number>);
  render(
    <PlayerProvider controller={controller}>
      <EndpointTable
        rows={rows}
        selectedKey={selectedKey}
        diffId="diff-1"
        onSelect={vi.fn()}
        t={t}
      />
    </PlayerProvider>
  );
}

describe("EndpointTable", () => {
  it(`renders at most ${MAX_ENDPOINT_ROWS} rows and says how many are hidden`, () => {
    renderTable(alignment(MAX_ENDPOINT_ROWS + 50));

    expect(screen.getAllByTestId("compare-endpoint-row")).toHaveLength(MAX_ENDPOINT_ROWS);
    expect(screen.getByTestId("compare-endpoints-capped")).toHaveTextContent(
      "Showing 300 of 350 endpoints."
    );
  });

  it("marks the picked row as current and points its button at the diff", () => {
    renderTable(alignment(3), "GET /api/1");

    const rows = screen.getAllByTestId("compare-endpoint-row");
    expect(rows[1]).toHaveAttribute("aria-current", "true");
    expect(rows[0]).not.toHaveAttribute("aria-current");
    expect(rows.some((row) => row.hasAttribute("aria-selected"))).toBe(false);
    const button = screen.getByRole("button", { name: "GET /api/1" });
    expect(button).toHaveAttribute("aria-controls", "diff-1");
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByTestId("compare-endpoints-capped")).toBeNull();
  });
});
