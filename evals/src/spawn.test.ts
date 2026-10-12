import { describe, expect, it } from "vitest";

import { spawnWithTimeout } from "./agent-runner.js";
import { partitionEvaluable, type ManifestEntry } from "./archive-manifest.js";

describe("spawnWithTimeout", () => {
  it("kills a child that ignores SIGTERM and still settles", async () => {
    const script =
      "process.on('SIGTERM', () => {}); console.log('started'); setInterval(() => {}, 1000);";
    const result = await spawnWithTimeout(
      process.execPath,
      ["-e", script],
      "",
      process.cwd(),
      300,
      200
    );

    expect(result.timedOut).toBe(true);
    expect(result.stdout).toContain("started");
  });

  it("collects the output of a child that exits on its own", async () => {
    const result = await spawnWithTimeout(
      process.execPath,
      ["-e", "process.stdin.pipe(process.stdout)"],
      "hello",
      process.cwd(),
      10_000
    );

    expect(result).toMatchObject({ stdout: "hello", exitCode: 0, timedOut: false });
  });
});

describe("partitionEvaluable", () => {
  const entry = (caseId: string, extra: Partial<ManifestEntry> = {}): ManifestEntry => ({
    caseId,
    scenarioId: caseId,
    profile: "default",
    file: `default/${caseId}.webblackbox`,
    bytes: 1,
    symptomReproduced: true,
    recordedAt: "",
    ...extra
  });

  it("skips failed recordings and recordings where the bug did not reproduce", () => {
    const { evaluable, skipped } = partitionEvaluable([
      entry("case-01"),
      entry("case-02", { symptomReproduced: false }),
      entry("case-03", { error: "boom", symptomReproduced: false })
    ]);

    expect(evaluable.map((item) => item.caseId)).toEqual(["case-01"]);
    expect(skipped.map((item) => item.caseId)).toEqual(["case-02", "case-03"]);
  });
});
