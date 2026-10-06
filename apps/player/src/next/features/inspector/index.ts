import type { PlayerFeature } from "../types.js";
import { inspectorMessages } from "./messages.js";

/**
 * Event inspector (R5): the Activity tab shows `InspectorPanel` while the details are open
 * (Enter), and the stage outlines the inspected target (`useInspectedTarget`).
 */
export const inspectorFeature: PlayerFeature = {
  id: "inspector",
  messages: inspectorMessages
};

export { InspectorPanel } from "./inspector-panel.js";
export { useInspectedTarget, type InspectedTargetFrame } from "./target-frame.js";
