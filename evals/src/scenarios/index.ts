// The bug zoo: every seeded scenario, in case order. Adding a scenario = one more entry here
// (see evals/README.md).

import type { Scenario } from "../types.js";
import { hiddenErrorToast, silentValidation, wrongRequestBody } from "./forms.js";
import {
  clickHandlerException,
  coveredButton,
  doubleSubmit,
  iframeException
} from "./interactions.js";
import { endlessSpinner, searchRace, staleCache, websocketStale } from "./network.js";
import { authRedirectLoop, featureFlagStorage } from "./state.js";

export const SCENARIOS: readonly Scenario[] = [
  silentValidation,
  hiddenErrorToast,
  clickHandlerException,
  coveredButton,
  wrongRequestBody,
  websocketStale,
  endlessSpinner,
  authRedirectLoop,
  iframeException,
  staleCache,
  featureFlagStorage,
  doubleSubmit,
  searchRace
];

/** Scenarios selected by id or case id; all of them for an empty selection. */
export function selectScenarios(selection: readonly string[]): readonly Scenario[] {
  if (selection.length === 0) {
    return SCENARIOS;
  }

  const unknown = selection.filter(
    (key) => !SCENARIOS.some((scenario) => scenario.id === key || scenario.caseId === key)
  );

  if (unknown.length > 0) {
    throw new Error(`Unknown scenario(s): ${unknown.join(", ")}`);
  }

  return SCENARIOS.filter(
    (scenario) => selection.includes(scenario.id) || selection.includes(scenario.caseId)
  );
}
