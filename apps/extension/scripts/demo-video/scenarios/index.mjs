// The usage videos, in recording order. Each scenario prepares the desktop off camera, then runs
// its steps on camera; a step's `say` is the caption shown from the moment the step starts.
//
// @typedef {{ id: string, say?: Record<string, string>, run?: (ctx: object) => Promise<unknown> }} Step
// @typedef {{ id: string, title: Record<string, string>, prepare: (ctx: object) => Promise<void>,
//   steps: Step[], cleanup?: (ctx: object) => Promise<void> }} Scenario
import { installScenario } from "./install.mjs";
import { recordAndExportScenario } from "./record-and-export.mjs";

/** @type {ReadonlyArray<Scenario>} */
export const SCENARIOS = Object.freeze([installScenario, recordAndExportScenario]);

export function findScenario(id) {
  return SCENARIOS.find((scenario) => scenario.id === id) ?? null;
}
