import type { CapturePolicy } from "@webblackbox/protocol";

import type { ChromeApi } from "../shared/chrome-api.js";
import { readManagedEnterprisePolicy } from "../shared/options-storage.js";
import type { ProfileCatalogEntry, ProfilePreviewResponse } from "../shared/messages.js";
import {
  PROFILES_STORAGE_KEY,
  isReadOnlyProfileId,
  type ProfileRule
} from "../shared/profiles/model.js";
import { selectionRequiresFullEngine } from "../shared/profiles/engine.js";
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

/** Start refused because every profile was deleted; the popup asks the user to create one. */
export const NO_RECORDING_PROFILE_ERROR =
  "No recording profile exists. Create or restore one in Options → Profiles, then start again.";
const MAX_META_VALUES = 10;
const MAX_META_VALUE_LENGTH = 500;

type ProfileStorageKeys = {
  legacyOptionsKey: string;
  enterprisePolicyKey: string;
};

/**
 * Reads the v2 store, v1 options and managed policy; never throws. `readManagedPolicy` replaces
 * the direct `storage.managed` read (the service worker passes its bounded, shared one).
 */
export async function loadProfilesState(
  chromeApi: ChromeApi | null,
  keys: ProfileStorageKeys,
  readManagedPolicy: () => Promise<Record<string, unknown> | null> = () =>
    readManagedEnterprisePolicy(chromeApi?.storage?.managed, keys.enterprisePolicyKey)
): Promise<ProfilesState> {
  const local = await chromeApi?.storage?.local
    ?.get([PROFILES_STORAGE_KEY, keys.legacyOptionsKey])
    .catch(() => undefined);
  const managedPolicy = await readManagedPolicy();

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
  rules: readonly ProfileRule[],
  /**
   * Null when the page probe fails or times out. Without it such a page has no signals: DOM rules
   * simply do not match (restricted pages such as chrome:// cannot be probed at all).
   */
  options: { requireSignals?: boolean } = {}
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

  if (!signals && options.requireSignals) {
    return null;
  }

  return {
    url,
    title: typeof tab?.title === "string" ? tab.title : undefined,
    incognito: tab?.incognito === true,
    ...signals
  };
}

/** The tab is still loading its document (title, meta tags and DOM may not be there yet). */
export async function isTabLoading(chromeApi: ChromeApi | null, tabId: number): Promise<boolean> {
  const tab = await chromeApi?.tabs?.get(tabId).catch(() => undefined);
  return tab?.status === "loading";
}

/** Popup preview: every selectable profile plus what Start would pick for the tab. */
export function buildProfilePreview(
  state: ProfilesState,
  selection: ProfileSelection | null,
  enterpriseCapped: readonly string[] = []
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
          requiresFull: selectionRequiresFullEngine(selection),
          ...(selection.profile.visual ? { visual: selection.profile.visual } : {}),
          ...(enterpriseCapped.length > 0 ? { enterpriseCapped: [...enterpriseCapped] } : {})
        }
      : null
  };
}

/** Visual data a session's profile allowed; the export includes what was captured. */
export type CapturedVisuals = { screenshots: boolean; screenRecordings: boolean };

export function capturedVisualsOf(config: {
  capturePolicy?: { categories: CapturePolicy["categories"] };
}): CapturedVisuals {
  const categories = config.capturePolicy?.categories;

  return {
    screenshots: categories ? categories.screenshots !== "off" : false,
    screenRecordings: categories?.screenRecordings === "allow"
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
): Promise<Pick<ProfilePageContext, "metaTags" | "selectorsPresent"> | null> {
  const scripting = chromeApi?.scripting;

  if (!scripting) {
    return null;
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

    const result = Array.isArray(results) ? results[0]?.result : undefined;
    // A timeout or an empty answer: the page could not be read.
    return result === undefined ? null : parsePageSignals(result, request);
  } catch {
    // Restricted pages (chrome://, web store) cannot be probed.
    return null;
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
