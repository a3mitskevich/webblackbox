import type { CapturePolicy } from "@webblackbox/protocol";

import type { ChromeApi } from "../shared/chrome-api.js";
import { readManagedEnterprisePolicy } from "../shared/options-storage.js";
import type { ProfileCatalogEntry, ProfilePreviewResponse } from "../shared/messages.js";
import {
  PROFILES_STORAGE_KEY,
  isReadOnlyProfileId,
  type ProfileRule
} from "../shared/profiles/model.js";
import { isExtendedCaptureProfile, type ProfileSelection } from "../shared/profiles/resolve.js";
import {
  collectPageSignalRequest,
  type ProfilePageContext,
  type ProfilePageSignalRequest
} from "../shared/profiles/rules.js";
import {
  parseManagedProfilesPolicy,
  resolveProfilesState,
  type ProfilesState
} from "../shared/profiles/storage.js";

const PAGE_SIGNAL_PROBE_TIMEOUT_MS = 1_500;
const MAX_META_VALUES = 10;
const MAX_META_VALUE_LENGTH = 500;

type ProfileStorageKeys = {
  legacyOptionsKey: string;
  enterprisePolicyKey: string;
};

/** Reads the v2 store, v1 options and managed policy; never throws. */
export async function loadProfilesState(
  chromeApi: ChromeApi | null,
  keys: ProfileStorageKeys
): Promise<ProfilesState> {
  const local = await chromeApi?.storage?.local
    ?.get([PROFILES_STORAGE_KEY, keys.legacyOptionsKey])
    .catch(() => undefined);
  const managedPolicy = await readManagedEnterprisePolicy(
    chromeApi?.storage?.managed,
    keys.enterprisePolicyKey
  );

  return resolveProfilesState({
    rawProfilesStore: local?.[PROFILES_STORAGE_KEY],
    rawLegacyOptions: local?.[keys.legacyOptionsKey],
    managed: parseManagedProfilesPolicy(managedPolicy)
  });
}

/**
 * What the rule engine needs about a tab: the raw URL (query params matter), title, incognito
 * flag, plus meta tags / selectors when some enabled rule asks for them.
 */
export async function readTabPageContext(
  chromeApi: ChromeApi | null,
  tabId: number,
  rules: readonly ProfileRule[]
): Promise<ProfilePageContext | null> {
  const tab = await chromeApi?.tabs?.get(tabId).catch(() => undefined);
  const url = typeof tab?.url === "string" ? tab.url : "";

  if (!url) {
    return null;
  }

  const request = collectPageSignalRequest(rules);
  const signals =
    request.metaNames.length > 0 || request.selectors.length > 0
      ? await probePageSignals(chromeApi, tabId, request)
      : {};

  return {
    url,
    title: typeof tab?.title === "string" ? tab.title : undefined,
    incognito: tab?.incognito === true,
    ...signals
  };
}

/** Popup preview: every selectable profile plus what Start would pick for the tab. */
export function buildProfilePreview(
  state: ProfilesState,
  selection: ProfileSelection | null
): ProfilePreviewResponse {
  const catalog: ProfileCatalogEntry[] = state.catalog.map((profile) => ({
    id: profile.id,
    name: profile.name,
    base: profile.base,
    extended: isExtendedCaptureProfile(profile),
    readOnly: isReadOnlyProfileId(profile.id)
  }));

  return {
    kind: "sw.profile-preview",
    catalog,
    selection: selection
      ? {
          id: selection.profile.id,
          name: selection.profile.name,
          base: selection.profile.base,
          source: selection.source,
          ...(selection.rule?.name ? { ruleName: selection.rule.name } : {}),
          extended: selection.extended,
          ...(selection.downgradedFrom ? { downgradedFrom: selection.downgradedFrom.name } : {})
        }
      : null
  };
}

/** Visual data a session captured under any of its profiles. */
export type CapturedVisuals = { screenshots: boolean; screenRecordings: boolean };

export const NO_CAPTURED_VISUALS: CapturedVisuals = { screenshots: false, screenRecordings: false };

/**
 * Adds what `config` allows to what the session already captured. The export keeps visuals
 * recorded while an earlier profile allowed them, even after a switch turned them off.
 */
export function mergeCapturedVisuals(
  previous: CapturedVisuals,
  config: { capturePolicy?: { categories: CapturePolicy["categories"] } }
): CapturedVisuals {
  const categories = config.capturePolicy?.categories;

  return {
    screenshots: previous.screenshots || (categories ? categories.screenshots !== "off" : false),
    screenRecordings: previous.screenRecordings || categories?.screenRecordings === "allow"
  };
}

/** Parses the untrusted probe result coming back from the page. */
export function parsePageSignals(
  value: unknown,
  request: ProfilePageSignalRequest
): Pick<ProfilePageContext, "metaTags" | "selectorsPresent"> {
  const record = asRecord(value);
  const metaRecord = asRecord(record?.metaTags);
  const selectorRecord = asRecord(record?.selectorsPresent);
  const metaTags: Record<string, string[]> = {};
  const selectorsPresent: Record<string, boolean> = {};

  for (const name of request.metaNames) {
    const values = metaRecord?.[name];

    if (Array.isArray(values)) {
      metaTags[name] = values
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, MAX_META_VALUES)
        .map((entry) => entry.slice(0, MAX_META_VALUE_LENGTH));
    }
  }

  for (const selector of request.selectors) {
    selectorsPresent[selector] = selectorRecord?.[selector] === true;
  }

  return { metaTags, selectorsPresent };
}

async function probePageSignals(
  chromeApi: ChromeApi | null,
  tabId: number,
  request: ProfilePageSignalRequest
): Promise<Pick<ProfilePageContext, "metaTags" | "selectorsPresent">> {
  const scripting = chromeApi?.scripting;

  if (!scripting) {
    return {};
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const results = await Promise.race([
      scripting.executeScript({
        target: { tabId },
        world: "ISOLATED",
        func: collectPageSignalsInPage as (...args: never[]) => unknown,
        args: [request.metaNames, request.selectors]
      }),
      new Promise<undefined>((resolve) => {
        timeoutId = setTimeout(() => resolve(undefined), PAGE_SIGNAL_PROBE_TIMEOUT_MS);
      })
    ]);

    return parsePageSignals(Array.isArray(results) ? results[0]?.result : undefined, request);
  } catch {
    // Restricted pages (chrome://, web store) cannot be probed: DOM rules simply do not match.
    return {};
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

/** Runs inside the page (serialized by chrome.scripting); must stay self-contained. */
function collectPageSignalsInPage(
  metaNames: string[],
  selectors: string[]
): { metaTags: Record<string, string[]>; selectorsPresent: Record<string, boolean> } {
  const metaTags: Record<string, string[]> = {};
  const selectorsPresent: Record<string, boolean> = {};
  const wanted = new Set(metaNames);

  for (const meta of Array.from(document.querySelectorAll("meta[name]"))) {
    const name = (meta.getAttribute("name") ?? "").toLowerCase();

    if (wanted.has(name)) {
      metaTags[name] = [...(metaTags[name] ?? []), meta.getAttribute("content") ?? ""];
    }
  }

  for (const selector of selectors) {
    try {
      selectorsPresent[selector] = document.querySelector(selector) !== null;
    } catch {
      selectorsPresent[selector] = false;
    }
  }

  return { metaTags, selectorsPresent };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
