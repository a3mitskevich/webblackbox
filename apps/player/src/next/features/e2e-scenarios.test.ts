import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { findFeatureScenarioFiles, loadFeatureScenarios } from "../../../scripts/lib/next-e2e.mjs";

const featuresDir = dirname(fileURLToPath(import.meta.url));
const temporary: string[] = [];

async function featureTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wb-features-"));
  temporary.push(root);

  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }

  return root;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("e2e:player-next feature scenarios", () => {
  it("picks up <feature>/<feature>.e2e.mjs in feature order", async () => {
    const root = await featureTree({
      "network/network.e2e.mjs":
        'export default { feature: "network", scenarios: [{ name: "a", run: async () => 1 }] };',
      "feed/feed.e2e.mjs":
        'export default { feature: "feed", scenarios: [{ name: "b", run: async () => 2 }] };',
      "perf/index.ts": "export {};",
      "console/other.e2e.mjs": "export default {};"
    });

    const files = await findFeatureScenarioFiles(root);
    expect(files.map((entry) => entry.feature)).toEqual(["feed", "network"]);

    const suites = await loadFeatureScenarios(files);
    expect(suites.map((suite) => suite.scenarios[0]?.name)).toEqual(["b", "a"]);
    expect((await loadFeatureScenarios(files, "network")).map((suite) => suite.feature)).toEqual([
      "network"
    ]);
  });

  it("rejects a scenario file of the wrong shape or feature", async () => {
    const root = await featureTree({
      "feed/feed.e2e.mjs": 'export default { feature: "network", scenarios: [] };'
    });

    await expect(loadFeatureScenarios(await findFeatureScenarioFiles(root))).rejects.toThrow(
      /must export default \{ feature: "feed"/
    );
  });

  it("fails on a filter naming a feature without scenarios, and on no scenarios at all", async () => {
    const root = await featureTree({
      "feed/feed.e2e.mjs":
        'export default { feature: "feed", scenarios: [{ name: "b", run: async () => 2 }] };'
    });
    const files = await findFeatureScenarioFiles(root);

    await expect(loadFeatureScenarios(files, "fed")).rejects.toThrow(/"fed"/);
    await expect(loadFeatureScenarios(files, "feed, network")).rejects.toThrow(/"network"/);
    await expect(loadFeatureScenarios([])).rejects.toThrow(/No feature scenarios/);
  });

  it("loads the scenarios shipped in src/next/features", async () => {
    const suites = await loadFeatureScenarios(await findFeatureScenarioFiles(featuresDir));
    expect(suites.map((suite) => suite.feature)).toContain("feed");
  });
});
