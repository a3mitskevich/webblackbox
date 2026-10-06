/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildCompareVariant } from "../../../../scripts/lib/synthetic-signals.mjs";
import {
  buildSyntheticSession,
  createPlainArchive,
  sha256Hex
} from "../../../../scripts/lib/synthetic-session.mjs";
import { createMediaUrlCache } from "../../../core/media-cache.js";
import { App } from "../../app.js";
import { createPlayerController } from "../../controller.js";
import { createInitialState, type PlayerState } from "../../state.js";
import { createStore } from "../../store.js";
import { buildDiffLines, diffHeaders } from "./body-diff.js";
import { clearCompare } from "./compare-session.js";
import { compareSlice } from "./slice.js";

let archiveA: Uint8Array;
let archiveB: Uint8Array;

beforeAll(async () => {
  archiveA = await createPlainArchive();
  archiveB = await createPlainArchive(buildCompareVariant(buildSyntheticSession(), sha256Hex));
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.location.hash = "";
});

async function renderCompare() {
  const store = createStore<PlayerState>(createInitialState("en", "light"));
  const controller = createPlayerController(store, {
    scheduler: { request: () => 0, cancel: () => undefined },
    mediaCache: createMediaUrlCache({ createUrl: () => "blob:frame", revokeUrl: () => undefined })
  });
  render(<App controller={controller} />);
  await act(async () => {
    await controller.openFile({
      name: "a.webblackbox",
      arrayBuffer: async () => archiveA.slice().buffer
    });
  });
  act(() => controller.setTab("compare"));
  await screen.findByTestId("compare-empty");
  return { store, controller };
}

async function chooseB(name: string, bytes: Uint8Array) {
  // jsdom's File has no arrayBuffer(); browsers do.
  const file = Object.assign(new File([bytes.slice()], name), {
    arrayBuffer: async () => bytes.slice().buffer
  });
  await act(async () => {
    fireEvent.change(screen.getByTestId("compare-input"), { target: { files: [file] } });
  });
}

describe("Compare panel", () => {
  it("compares the open archive with session B and diffs a regressed endpoint", async () => {
    const { store } = await renderCompare();

    await chooseB("b.webblackbox", archiveB);
    const report = await screen.findByTestId("compare-report");

    expect(screen.getByTestId("compare-file-name")).toHaveTextContent("b.webblackbox");
    expect(within(report).getByTestId("compare-delta-events")).toHaveTextContent("+1");
    const rows = within(report).getAllByTestId("compare-endpoint-row");
    const signals = rows.map((row) => row.dataset.signal);
    expect(signals).toContain("regressed");
    expect(signals).toContain("new");
    expect(signals).not.toContain("stable");

    const regressed = rows.find((row) => row.textContent?.includes("games/api/v1.0/game/64"));
    fireEvent.click(regressed as HTMLElement);
    expect(compareSlice.select(store.getState()).selectedKey).toBe(
      "GET /gw/bff/games/api/v1.0/game/64"
    );
    const diff = await screen.findByTestId("compare-body-diff");
    expect(diff).toHaveTextContent('"status": "open"');
    expect(diff).toHaveTextContent('"status": "closed"');
    expect(diff.querySelector('[data-kind="add"]')).not.toBeNull();

    expect(regressed).toHaveAttribute("aria-current", "true");
    const diffId = within(regressed as HTMLElement)
      .getByRole("button")
      .getAttribute("aria-controls");
    expect(screen.getByTestId("compare-diff")).toHaveAttribute("id", diffId);

    const types = within(report).getByTestId("compare-types");
    expect(
      within(types)
        .getAllByRole("columnheader")
        .map((header) => header.textContent)
    ).toEqual(["Event type", "Count in A", "Count in B", "Δ count"]);

    fireEvent.click(screen.getByTestId("compare-only-changed"));
    expect(
      within(report)
        .getAllByTestId("compare-endpoint-row")
        .some((row) => row.dataset.signal === "stable")
    ).toBe(true);

    fireEvent.click(screen.getByTestId("compare-clear"));
    expect(screen.getByTestId("compare-empty")).toBeInTheDocument();
  });

  it("reports a file that is not an archive and keeps the empty state", async () => {
    const { store } = await renderCompare();

    await chooseB("notes.txt", new Uint8Array([1, 2, 3]));
    expect(screen.getByTestId("compare-error")).toHaveTextContent("Choose a .webblackbox");

    await chooseB("broken.zip", new Uint8Array([1, 2, 3]));
    expect(await screen.findByTestId("compare-error")).toHaveTextContent(
      "Could not open broken.zip"
    );
    act(() => clearCompare(store));
    expect(screen.getByTestId("compare-empty")).toBeInTheDocument();
  });
});

describe("diff helpers", () => {
  it("folds long unchanged runs and numbers both sides", () => {
    const left = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
    const right = left.replace("line 10", "line ten");
    const lines = buildDiffLines(left, right) ?? [];

    expect(lines.filter((line) => line.kind === "fold")).toHaveLength(2);
    expect(lines.find((line) => line.kind === "del")).toMatchObject({ text: "line 10", left: 11 });
    expect(lines.find((line) => line.kind === "add")).toMatchObject({
      text: "line ten",
      right: 11
    });
  });

  it("diffs headers case-insensitively", () => {
    expect(
      diffHeaders(
        { "Content-Type": "application/json", "x-old": "1", etag: "a" },
        { "content-type": "application/json", etag: "b", "x-new": "2" }
      )
    ).toEqual([
      { name: "etag", kind: "changed", left: "a", right: "b" },
      { name: "x-new", kind: "added", right: "2" },
      { name: "x-old", kind: "removed", left: "1" }
    ]);
  });
});
