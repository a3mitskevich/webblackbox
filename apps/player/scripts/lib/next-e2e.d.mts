// Types for the parts of next-e2e.mjs that unit tests import (scenario discovery).
export type FeatureScenarioFile = { feature: string; file: string };

export type FeatureScenario = { name: string; run: (context: unknown) => Promise<unknown> };

export type FeatureScenarioSuite = { feature: string; scenarios: FeatureScenario[] };

export declare function findFeatureScenarioFiles(
  featuresDir: string
): Promise<FeatureScenarioFile[]>;

export declare function loadFeatureScenarios(
  files: readonly FeatureScenarioFile[],
  only?: string | null
): Promise<FeatureScenarioSuite[]>;
