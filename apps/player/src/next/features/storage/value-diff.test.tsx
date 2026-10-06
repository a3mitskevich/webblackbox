/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createMediaUrlCache } from "../../../core/media-cache.js";
import { PlayerProvider } from "../../context.js";
import { createPlayerController } from "../../controller.js";
import { createInitialState, type PlayerState } from "../../state.js";
import { createStore } from "../../store.js";
import {
  diffJsonValues,
  diffWordWindow,
  MAX_DIFF_WINDOW_CHARS,
  MAX_FIELD_VALUE_CHARS,
  MAX_JSON_DIFF_CHARS,
  ValueDiff
} from "./value-diff.js";

afterEach(() => {
  cleanup();
});

function renderDiff(before: string, after: string) {
  const store = createStore<PlayerState>(createInitialState("en", "light"));
  const controller = createPlayerController(store, {
    scheduler: { request: () => 0, cancel: () => undefined },
    mediaCache: createMediaUrlCache({ createUrl: () => "blob:frame", revokeUrl: () => undefined })
  });
  return render(
    <PlayerProvider controller={controller}>
      <ValueDiff before={before} after={after} />
    </PlayerProvider>
  );
}

const changedText = (parts: { added?: boolean; removed?: boolean; value: string }[]) => ({
  removed: parts.filter((part) => part.removed).map((part) => part.value),
  added: parts.filter((part) => part.added).map((part) => part.value)
});

describe("word diff window", () => {
  it("finds a change far past the old 32 KiB cut", () => {
    const head = "word ".repeat(20_000);
    const diff = diffWordWindow(`${head}alpha tail`, `${head}beta tail`);

    expect(changedText(diff.parts)).toEqual({ removed: ["alpha"], added: ["beta"] });
    expect(diff.isPrefixElided).toBe(true);
    expect(diff.prefix.length).toBeLessThanOrEqual(80);
    expect(diff.suffix).toBe(" tail");
    expect(diff.isSuffixElided).toBe(false);
    expect(diff.isLimited).toBe(false);
  });

  it("diffs whole words when the common prefix or suffix ends mid-word", () => {
    const diff = diffWordWindow("hello world again", "hello wordy again");

    expect(diff.prefix).toBe("hello ");
    expect(changedText(diff.parts)).toEqual({ removed: ["world"], added: ["wordy"] });
    expect(diff.suffix).toBe(" again");
  });

  it("never splits a surrogate pair at the cut points", () => {
    const hasLoneSurrogate = (text: string) =>
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
    const emoji = "😀".repeat(60);
    const diff = diffWordWindow(`${emoji} 😀 ${emoji}`, `${emoji} 😁 ${emoji}`);
    const texts = [diff.prefix, diff.suffix, ...diff.parts.map((part) => part.value)];

    expect(texts.some(hasLoneSurrogate)).toBe(false);
    expect(changedText(diff.parts)).toEqual({ removed: ["😀"], added: ["😁"] });
  });

  it("caps a long differing middle and says so", () => {
    const before = `start ${"x".repeat(MAX_DIFF_WINDOW_CHARS + 5_000)} end`;
    const after = `start ${"y".repeat(MAX_DIFF_WINDOW_CHARS + 5_000)} end`;
    const diff = diffWordWindow(before, after);

    expect(diff.isLimited).toBe(true);
    expect(diff.parts.reduce((sum, part) => sum + part.value.length, 0)).toBe(
      MAX_DIFF_WINDOW_CHARS * 2
    );

    renderDiff(before, after);
    expect(screen.getByTestId("storage-diff-limited")).toHaveTextContent(
      "only its first 32,768 characters are compared"
    );
    expect(screen.getByTestId("storage-word-diff").querySelectorAll(".elided")).toHaveLength(1);
  });

  it("renders the elided context around a late change", () => {
    const head = "word ".repeat(20_000);
    renderDiff(`${head}alpha`, `${head}beta`);
    const diff = screen.getByTestId("storage-word-diff");

    expect(diff.textContent?.startsWith("…")).toBe(true);
    expect(diff.querySelector(".del")).toHaveTextContent("alpha");
    expect(diff.querySelector(".ins")).toHaveTextContent("beta");
    expect(screen.queryByTestId("storage-diff-limited")).toBeNull();
  });
});

describe("JSON field diff bounds", () => {
  it("caps each shown value", () => {
    const big = "z".repeat(MAX_FIELD_VALUE_CHARS * 10);
    const fields = diffJsonValues(JSON.stringify({ a: big }), JSON.stringify({ a: 1 }));
    const before = fields?.[0]?.before ?? "";

    expect(before).toHaveLength(MAX_FIELD_VALUE_CHARS + 1);
    expect(before.endsWith("…")).toBe(true);
    expect(fields?.[0]?.after).toBe("1");
  });

  it("leaves values over the JSON limit to the word diff", () => {
    const big = JSON.stringify({ a: "q".repeat(MAX_JSON_DIFF_CHARS) });

    expect(diffJsonValues(big, '{"a":1}')).toBeNull();
    expect(diffJsonValues('{"a":1}', big)).toBeNull();
  });
});
