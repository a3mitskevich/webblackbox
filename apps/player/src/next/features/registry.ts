import { RAIL_TABS, type RailTab } from "../../core/url-hash.js";
import { compareFeature } from "./compare/index.js";
import { consoleFeature } from "./console/index.js";
import { extensionGuideFeature } from "./extension-guide/index.js";
import { feedFeature } from "./feed/index.js";
import { generateFeature } from "./generate/index.js";
import { inspectorFeature } from "./inspector/index.js";
import { mergeFeatureCatalog, type FeatureCatalog } from "./messages.js";
import { networkFeature } from "./network/index.js";
import { perfFeature } from "./perf/index.js";
import { shareFeature } from "./share/index.js";
import { storageFeature } from "./storage/index.js";
import { tabsFeature } from "./tabs/index.js";
import { FEATURE_IDS, type PlayerFeature, type RailTabRegistration } from "./types.js";

/**
 * Every feature folder, imported once here. All ten are listed from the start, so a stage that
 * builds its feature only edits files inside `features/<feature>/`.
 */
export const PLAYER_FEATURES: readonly PlayerFeature[] = [
  feedFeature,
  networkFeature,
  consoleFeature,
  storageFeature,
  tabsFeature,
  perfFeature,
  compareFeature,
  shareFeature,
  inspectorFeature,
  generateFeature,
  extensionGuideFeature
];

/**
 * Rail tabs by id, checked at startup: each id is a known `RAIL_TABS` entry (the URL hash and
 * the 1…7 keys use that order) and is registered by exactly one feature.
 */
export function collectRailTabs(
  features: readonly PlayerFeature[]
): ReadonlyMap<RailTab, RailTabRegistration> {
  const unknownFeature = features.find(
    (feature) => !(FEATURE_IDS as readonly string[]).includes(feature.id)
  );

  if (unknownFeature) {
    throw new Error(`Unknown player feature "${unknownFeature.id}".`);
  }

  const tabs = new Map<RailTab, RailTabRegistration>();

  for (const feature of features) {
    for (const registration of feature.railTabs ?? []) {
      if (!RAIL_TABS.includes(registration.id)) {
        throw new Error(`Feature "${feature.id}" registers unknown rail tab "${registration.id}".`);
      }

      if (tabs.has(registration.id)) {
        throw new Error(`Rail tab "${registration.id}" is registered twice.`);
      }

      tabs.set(registration.id, registration);
    }
  }

  return tabs;
}

export const RAIL_TAB_REGISTRY = collectRailTabs(PLAYER_FEATURES);

/** The registered rail tabs in `RAIL_TABS` order. */
export const RAIL_TAB_ORDER: readonly RailTabRegistration[] = RAIL_TABS.flatMap((tab) => {
  const registration = RAIL_TAB_REGISTRY.get(tab);
  return registration ? [registration] : [];
});

/** All feature strings merged at startup (`locale → "<feature>.<key>"`). */
export const FEATURE_CATALOG: FeatureCatalog = mergeFeatureCatalog(
  PLAYER_FEATURES.flatMap((feature) => (feature.messages ? [feature.messages] : []))
);
