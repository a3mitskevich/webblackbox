import { DEFAULT_CAPTURE_POLICY } from "@webblackbox/protocol";
import { describe, expect, it, vi } from "vitest";

import type { ChromeApi } from "../shared/chrome-api.js";
import { DEFAULT_PROFILE_ID, PROFILES_STORAGE_KEY } from "../shared/profiles/model.js";
import { BUILT_IN_PROFILE_IDS, createDefaultProfile } from "../shared/profiles/presets.js";
import { selectRecordingProfile } from "../shared/profiles/resolve.js";
import {
  buildProfilePreview,
  loadProfilesState,
  mergeCapturedVisuals,
  NO_CAPTURED_VISUALS,
  parsePageSignals,
  readTabPageContext
} from "./profile-runtime.js";

const KEYS = { legacyOptionsKey: "webblackbox.options", enterprisePolicyKey: "enterprisePolicy" };

function fakeChrome(options: {
  local?: Record<string, unknown>;
  managed?: Record<string, unknown> | Error;
  tab?: { url?: string; title?: string; incognito?: boolean };
  probe?: unknown;
}): { api: ChromeApi; executeScript: ReturnType<typeof vi.fn> } {
  const executeScript = vi.fn(async () => [{ result: options.probe }]);
  const api = {
    storage: {
      local: { get: vi.fn(async () => options.local ?? {}), set: vi.fn() },
      managed: {
        // Like Chrome: only the requested keys come back; `null` returns everything.
        get: vi.fn(async (keys?: string | null) => {
          if (options.managed instanceof Error) {
            throw options.managed;
          }

          const values = options.managed ?? {};
          return typeof keys === "string"
            ? keys in values
              ? { [keys]: values[keys] }
              : {}
            : values;
        })
      }
    },
    tabs: { get: vi.fn(async () => options.tab ?? {}) },
    scripting: { executeScript }
  } as unknown as ChromeApi;

  return { api, executeScript };
}

const STAGE_RULE = {
  id: "stage",
  profileId: BUILT_IN_PROFILE_IDS.qa,
  priority: 1,
  enabled: true,
  match: { hosts: ["*.stage.test"], metaTag: { name: "environment", value: "qa" } }
};

describe("loadProfilesState", () => {
  it("survives storage failures and missing APIs", async () => {
    const { api } = fakeChrome({ managed: new Error("no managed storage") });

    await expect(loadProfilesState(api, KEYS)).resolves.toMatchObject({ legacy: true });
    await expect(loadProfilesState(null, KEYS)).resolves.toMatchObject({ legacy: true });
  });

  it("reads the v2 store and managed rules", async () => {
    const { api } = fakeChrome({
      local: {
        [PROFILES_STORAGE_KEY]: {
          schemaVersion: 2,
          defaultProfileId: DEFAULT_PROFILE_ID,
          profiles: [createDefaultProfile()],
          rules: [],
          extendedCaptureHosts: []
        }
      },
      managed: { enterprisePolicy: { rules: [STAGE_RULE] } }
    });
    const state = await loadProfilesState(api, KEYS);

    expect(state.legacy).toBe(false);
    expect(state.rules.map((rule) => rule.id)).toEqual(["managed:stage"]);
  });
});

describe("loadProfilesState with a flat managed policy", () => {
  it("reads managed rules set as top-level policy keys", async () => {
    const { api } = fakeChrome({ managed: { rules: [STAGE_RULE] } });
    const state = await loadProfilesState(api, KEYS);

    expect(state.rules.map((rule) => rule.id)).toEqual(["managed:stage"]);
  });
});

describe("readTabPageContext", () => {
  it("returns null without a tab URL", async () => {
    const { api } = fakeChrome({ tab: {} });

    await expect(readTabPageContext(api, 1, [])).resolves.toBeNull();
  });

  it("does not probe the page when no rule needs DOM signals", async () => {
    const { api, executeScript } = fakeChrome({
      tab: { url: "https://a.stage.test/?env=qa", title: "A", incognito: true }
    });

    await expect(readTabPageContext(api, 1, [])).resolves.toEqual({
      url: "https://a.stage.test/?env=qa",
      title: "A",
      incognito: true
    });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("probes meta tags and selectors and feeds the rule engine", async () => {
    const { api, executeScript } = fakeChrome({
      tab: { url: "https://a.stage.test/" },
      probe: { metaTags: { environment: ["qa"] }, selectorsPresent: {} }
    });
    const context = await readTabPageContext(api, 3, [STAGE_RULE]);

    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 3 }, args: [["environment"], []] })
    );
    expect(context?.metaTags).toEqual({ environment: ["qa"] });
  });

  it("treats a failing probe as no signals", async () => {
    const { api, executeScript } = fakeChrome({ tab: { url: "https://a.stage.test/" } });
    executeScript.mockRejectedValueOnce(new Error("Cannot access contents of the page"));

    await expect(readTabPageContext(api, 3, [STAGE_RULE])).resolves.toMatchObject({
      url: "https://a.stage.test/"
    });
  });
});

describe("parsePageSignals", () => {
  it("keeps only requested, well-typed values", () => {
    expect(
      parsePageSignals(
        {
          metaTags: { environment: ["qa", 5, "x".repeat(600)], other: ["nope"] },
          selectorsPresent: { "#app": true, "#gone": "yes" }
        },
        { metaNames: ["environment"], selectors: ["#app", "#gone"], needsTitle: false }
      )
    ).toEqual({
      metaTags: { environment: ["qa", "x".repeat(500)] },
      selectorsPresent: { "#app": true, "#gone": false }
    });
    expect(
      parsePageSignals("garbage", { metaNames: ["a"], selectors: ["b"], needsTitle: false })
    ).toEqual({ metaTags: {}, selectorsPresent: { b: false } });
  });
});

describe("buildProfilePreview", () => {
  it("lists the catalog and the selection", async () => {
    const { api } = fakeChrome({});
    const state = await loadProfilesState(api, KEYS);
    const selection = selectRecordingProfile({
      state,
      page: { url: "https://mail.example.org/" },
      requestedProfileId: BUILT_IN_PROFILE_IDS.qa
    });
    const preview = buildProfilePreview(state, selection);

    expect(preview.catalog.find((entry) => entry.id === BUILT_IN_PROFILE_IDS.qa)).toEqual({
      id: BUILT_IN_PROFILE_IDS.qa,
      name: "QA",
      base: "full",
      extended: true,
      readOnly: true
    });
    expect(preview.selection).toEqual({
      id: BUILT_IN_PROFILE_IDS.full,
      name: "Full",
      base: "full",
      source: "explicit",
      extended: false,
      downgradedFrom: "QA"
    });
  });

  it("tells the popup which visual capture the selected profile pins", async () => {
    const { api } = fakeChrome({
      local: {
        [PROFILES_STORAGE_KEY]: {
          schemaVersion: 2,
          defaultProfileId: DEFAULT_PROFILE_ID,
          profiles: [{ ...createDefaultProfile(), visual: "both" }],
          rules: [],
          extendedCaptureHosts: []
        }
      }
    });
    const state = await loadProfilesState(api, KEYS);
    const selection = selectRecordingProfile({ state, page: { url: "https://example.org/" } });

    expect(buildProfilePreview(state, selection).selection?.visual).toBe("both");
  });
});

describe("mergeCapturedVisuals", () => {
  const categories = (screenshots: "off" | "allow", screenRecordings: "off" | "allow") => ({
    capturePolicy: {
      categories: { ...DEFAULT_CAPTURE_POLICY.categories, screenshots, screenRecordings }
    }
  });

  it("keeps visuals an earlier profile allowed after a switch turns them off", () => {
    const started = mergeCapturedVisuals(NO_CAPTURED_VISUALS, categories("allow", "allow"));
    const switched = mergeCapturedVisuals(started, categories("off", "off"));

    expect(switched).toEqual({ screenshots: true, screenRecordings: true });
    expect(mergeCapturedVisuals(NO_CAPTURED_VISUALS, categories("off", "off"))).toEqual(
      NO_CAPTURED_VISUALS
    );
    expect(mergeCapturedVisuals(NO_CAPTURED_VISUALS, {})).toEqual(NO_CAPTURED_VISUALS);
  });
});
