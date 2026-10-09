import { describe, expect, it } from "vitest";

import {
  buildAss,
  cuesFromMarks,
  dryRunMarks,
  escapeAssText,
  formatAssTime,
  LANGS,
  readingTimeMs,
  validateScenario,
  winToWslPath
} from "./captions.mjs";
import { SCENARIOS } from "../scenarios/index.mjs";

describe("demo-video captions", () => {
  it("gives short captions a floor and long ones time to read", () => {
    expect(readingTimeMs("OK")).toBe(2200);
    expect(readingTimeMs("x".repeat(150))).toBe(10_500);
  });

  it("turns caption marks into back-to-back cues ending at the video end", () => {
    const cues = cuesFromMarks(
      [
        { atMs: 4000, text: "second" },
        { atMs: -120, text: "first" },
        { atMs: 9000, text: "third" }
      ],
      12_000
    );
    expect(cues).toEqual([
      { startMs: 0, endMs: 4000, text: "first" },
      { startMs: 4000, endMs: 9000, text: "second" },
      { startMs: 9000, endMs: 12_000, text: "third" }
    ]);
  });

  it("drops empty captions and captions that start after the video ends", () => {
    const cues = cuesFromMarks(
      [
        { atMs: 0, text: "  " },
        { atMs: 1000, text: "kept" },
        { atMs: 5000, text: "too late" }
      ],
      3000
    );
    expect(cues).toEqual([{ startMs: 1000, endMs: 3000, text: "kept" }]);
  });

  it("formats ASS times as h:mm:ss.cc", () => {
    expect(formatAssTime(0)).toBe("0:00:00.00");
    expect(formatAssTime(83_456)).toBe("0:01:23.46");
    expect(formatAssTime(3_725_010)).toBe("1:02:05.01");
  });

  it("escapes override braces, backslashes and line breaks", () => {
    expect(escapeAssText("a {\\b1} b\nc")).toBe("a (\u29f5b1) b\\Nc");
  });

  it("builds an ASS file sized for the video plus the caption bar", () => {
    const ass = buildAss({
      cues: [
        { startMs: 2500, endMs: 4000, text: "Второй" },
        { startMs: 0, endMs: 2500, text: "Первый" }
      ],
      width: 1600,
      videoHeight: 1000,
      barHeight: 110,
      title: "Установка"
    });
    expect(ass).toContain("PlayResX: 1600\nPlayResY: 1110\n");
    expect(ass).toContain("Title: Установка");
    const dialogues = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
    expect(dialogues).toEqual([
      "Dialogue: 0,0:00:00.00,0:00:02.50,Caption,,0,0,0,,{\\an5\\pos(800,1055)}Первый",
      "Dialogue: 0,0:00:02.50,0:00:04.00,Caption,,0,0,0,,{\\an5\\pos(800,1055)}Второй"
    ]);
  });

  it("dry-runs a scenario into one cue per captioned step", () => {
    const steps = [
      { id: "a", say: { ru: "Шаг один" } },
      { id: "silent" },
      { id: "b", say: { ru: "Шаг два" } }
    ];
    const { marks, endMs } = dryRunMarks(steps, "ru", 1000);
    expect(marks).toEqual([
      { atMs: 0, text: "Шаг один" },
      { atMs: 3200, text: "Шаг два" }
    ]);
    expect(endMs).toBe(3200 + 2200 + 1000);
  });

  it("maps Windows drive paths onto the WSL mount", () => {
    expect(winToWslPath("C:\\Users\\Admin\\wbb-demo")).toBe("/mnt/c/Users/Admin/wbb-demo");
    expect(winToWslPath("D:/videos/")).toBe("/mnt/d/videos");
    expect(() => winToWslPath("\\\\server\\share")).toThrow(/drive path/u);
  });

  it("reports scenario definition problems", () => {
    const problems = validateScenario({
      id: "broken",
      title: { ru: "" },
      steps: [
        { id: "x", say: { ru: "" } },
        { id: "x", run: "not a function" }
      ]
    });
    expect(problems).toEqual([
      "broken: missing title.ru",
      "broken/x: missing say.ru",
      "broken: duplicate step id x",
      "broken/x: run is not a function"
    ]);
  });

  it("every recorded scenario is valid and captioned in every language", () => {
    expect(SCENARIOS.length).toBeGreaterThan(0);
    expect(new Set(SCENARIOS.map((scenario) => scenario.id)).size).toBe(SCENARIOS.length);
    for (const scenario of SCENARIOS) {
      expect(validateScenario(scenario)).toEqual([]);
      for (const lang of LANGS) {
        const { marks } = dryRunMarks(scenario.steps, lang);
        expect(marks.every((mark) => mark.text.trim().length > 0)).toBe(true);
      }
    }
  });
});
