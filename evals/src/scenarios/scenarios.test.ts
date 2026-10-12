import { describe, expect, it } from "vitest";

import { parseAgentAnswer, scoreAnswer } from "../rubric.js";
import { SCENARIOS, selectScenarios } from "./index.js";

/** Words that would hand the agent the cause through a URL, title or archive name. */
const LEAK_WORDS = [
  "bug",
  "zoo",
  "broken",
  "seeded",
  "race",
  "stale",
  "loop",
  "overlay",
  "covered",
  "silent",
  "exception",
  "wrong",
  "spinner",
  "double",
  "duplicate",
  "expired",
  "override"
];

describe("bug zoo scenarios", () => {
  it("has 10–15 scenarios with unique ids and case ids", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(10);
    expect(SCENARIOS.length).toBeLessThanOrEqual(15);
    expect(new Set(SCENARIOS.map((scenario) => scenario.id)).size).toBe(SCENARIOS.length);
    expect(new Set(SCENARIOS.map((scenario) => scenario.caseId)).size).toBe(SCENARIOS.length);

    for (const scenario of SCENARIOS) {
      expect(scenario.caseId).toMatch(/^case-\d{2}$/);
    }
  });

  it.each(SCENARIOS.map((scenario) => [scenario.id, scenario] as const))(
    "%s: the reference cause passes its own rubric",
    (_id, scenario) => {
      const reference = parseAgentAnswer(
        "```json\n" +
          JSON.stringify({
            rootCause: scenario.rubric.rootCause,
            evidence: scenario.rubric.keyEvidence
          }) +
          "\n```"
      );
      const score = scoreAnswer(reference, scenario.rubric);

      expect(score.required.filter((fact) => !fact.matched)).toEqual([]);
      expect(score.forbidden.filter((fact) => fact.matched)).toEqual([]);
      expect(score.pass).toBe(true);
    }
  );

  it.each(SCENARIOS.map((scenario) => [scenario.id, scenario] as const))(
    "%s: an unrelated answer fails its rubric",
    (_id, scenario) => {
      const unrelated = parseAgentAnswer(
        '```json\n{"rootCause": "Unclear; the user may have misclicked.", "evidence": []}\n```'
      );

      expect(scoreAnswer(unrelated, scenario.rubric).pass).toBe(false);
    }
  );

  it.each(SCENARIOS.map((scenario) => [scenario.id, scenario] as const))(
    "%s: has tester reports in Russian and English that describe only the symptom",
    (_id, scenario) => {
      expect(scenario.report.ru).toMatch(/[а-яё]/i);
      expect(scenario.report.en).toMatch(/^[^а-яё]+$/i);

      for (const text of [scenario.report.ru, scenario.report.en]) {
        expect(text.length).toBeGreaterThan(60);
        expect(text).not.toMatch(
          /\/api\/|(?<![\d-])[45]\d\d(?![\d-])|exception|TypeError|cache|websocket/i
        );
      }
    }
  );

  it.each(SCENARIOS.map((scenario) => [scenario.id, scenario] as const))(
    "%s: routes, titles and the case id do not give the cause away",
    (_id, scenario) => {
      const visible = [
        scenario.caseId,
        ...Object.keys(scenario.pages),
        ...Object.keys(scenario.scripts ?? {}),
        ...Object.keys(scenario.api ?? {}),
        ...Object.keys(scenario.sockets ?? {}),
        ...Object.values(scenario.pages).map((html) => /<title>([^<]*)<\/title>/.exec(html)?.[1])
      ].join("\n");

      for (const word of LEAK_WORDS) {
        expect(visible.toLowerCase()).not.toContain(word);
      }
    }
  );

  it.each(SCENARIOS.map((scenario) => [scenario.id, scenario] as const))(
    "%s: steps only open its own pages and never call alert()",
    (_id, scenario) => {
      const steps = [...(scenario.setup ?? []), ...scenario.steps];
      const navigations = steps.filter((step) => step.kind === "navigate");

      expect(scenario.steps[0]?.kind).toBe("navigate");

      for (const step of navigations) {
        expect(step.path === "/" || step.path in scenario.pages).toBe(true);
      }

      const sources = [
        ...Object.values(scenario.pages),
        ...Object.values(scenario.scripts ?? {}),
        scenario.symptom,
        JSON.stringify(steps)
      ];

      for (const source of sources) {
        expect(source).not.toMatch(/\b(alert|confirm|prompt)\(/);
      }
    }
  );

  it("selects scenarios by id or case id and rejects unknown ones", () => {
    expect(selectScenarios([]).length).toBe(SCENARIOS.length);
    expect(selectScenarios(["case-02", "search-race"]).map((scenario) => scenario.id)).toEqual([
      "hidden-error-toast",
      "search-race"
    ]);
    expect(() => selectScenarios(["nope"])).toThrow(/Unknown scenario/);
  });
});
