import { DEFAULT_CAPTURE_POLICY } from "@webblackbox/protocol";
import { describe, expect, it, vi } from "vitest";

import type { ChromeApi } from "../shared/chrome-api.js";
import { DEFAULT_PROFILE_ID, PROFILES_STORAGE_KEY } from "../shared/profiles/model.js";
import {
  BUILT_IN_PROFILE_IDS,
  createDefaultProfile,
  RECOMMENDED_PROFILE_IDS
} from "../shared/profiles/presets.js";
import { selectRecordingProfile } from "../shared/profiles/resolve.js";
import {
  buildProfilePreview,
  capturedVisualsOf,
  isTabLoading,
  loadProfilesState,
  parsePageSignals,
  readTabPageContext
} from "./profile-runtime.js";

const KEYS = { legacyOptionsKey: "webblackbox.options", enterprisePolicyKey: "enterprisePolicy" };

function fakeChrome(options: {
  local?: Record<string, unknown>;
  managed?: Record<string, unknown> | Error;
  tab?: { url?: string; title?: string; incognito?: boolean; status?: string };
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

describe("loadProfilesState with a managed policy reader", () => {
  it("reads managed rules through the given reader instead of the storage area", async () => {
    const { api } = fakeChrome({ managed: { rules: [] } });
    const readManagedPolicy = vi.fn(async () => ({ rules: [STAGE_RULE] }));
    const state = await loadProfilesState(api, KEYS, readManagedPolicy);

    expect(readManagedPolicy).toHaveBeenCalledTimes(1);
    expect(api.storage?.managed?.get).not.toHaveBeenCalled();
    expect(state.rules.map((rule) => rule.id)).toEqual(["managed:stage"]);
  });

  it("treats a reader without a policy as no managed profiles", async () => {
    const { api } = fakeChrome({});
    const state = await loadProfilesState(api, KEYS, async () => null);

    expect(state.rules).toEqual([]);
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

  it("returns null when the signals are required but the probe fails or times out", async () => {
    vi.useFakeTimers();

    try {
      const failing = fakeChrome({ tab: { url: "https://a.stage.test/" } });
      failing.executeScript.mockRejectedValueOnce(new Error("Frame was removed"));
      await expect(
        readTabPageContext(failing.api, 3, [STAGE_RULE], { requireSignals: true })
      ).resolves.toBeNull();

      const hanging = fakeChrome({ tab: { url: "https://a.stage.test/" } });
      hanging.executeScript.mockReturnValueOnce(new Promise(() => undefined));
      const pending = readTabPageContext(hanging.api, 3, [STAGE_RULE], { requireSignals: true });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toBeNull();

      const empty = fakeChrome({ tab: { url: "https://a.stage.test/" }, probe: undefined });
      await expect(
        readTabPageContext(empty.api, 3, [STAGE_RULE], { requireSignals: true })
      ).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the page when the signals are required and the probe answers", async () => {
    const { api } = fakeChrome({
      tab: { url: "https://a.stage.test/" },
      probe: { metaTags: { environment: ["qa"] }, selectorsPresent: {} }
    });

    await expect(
      readTabPageContext(api, 3, [STAGE_RULE], { requireSignals: true })
    ).resolves.toMatchObject({ metaTags: { environment: ["qa"] } });
  });
});

describe("isTabLoading", () => {
  it("is true only while Chrome reports the tab as loading", async () => {
    await expect(isTabLoading(fakeChrome({ tab: { status: "loading" } }).api, 1)).resolves.toBe(
      true
    );
    await expect(isTabLoading(fakeChrome({ tab: { status: "complete" } }).api, 1)).resolves.toBe(
      false
    );
    await expect(isTabLoading(null, 1)).resolves.toBe(false);
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
    // Extended profiles run on any host: no downgrade to Full.
    expect(preview.selection).toEqual({
      id: BUILT_IN_PROFILE_IDS.qa,
      name: "QA",
      base: "full",
      source: "explicit",
      extended: true
    });
    expect(buildProfilePreview(state, selection, ["console"]).selection?.enterpriseCapped).toEqual([
      "console"
    ]);
  });

  it("returns an empty catalog and no selection once every profile is deleted", async () => {
    const { api } = fakeChrome({
      local: {
        [PROFILES_STORAGE_KEY]: {
          schemaVersion: 2,
          defaultProfileId: "default",
          profiles: [],
          rules: [],
          extendedCaptureHosts: [],
          removedRecommendedProfileIds: [...RECOMMENDED_PROFILE_IDS]
        }
      }
    });
    const state = await loadProfilesState(api, KEYS);
    const selection = selectRecordingProfile({ state, page: { url: "https://a.example/" } });

    expect(selection).toBeNull();
    expect(buildProfilePreview(state, selection)).toEqual({
      kind: "sw.profile-preview",
      catalog: [],
      selection: null
    });
  });
});

describe("capturedVisualsOf", () => {
  const categories = (screenshots: "off" | "allow", screenRecordings: "off" | "allow") => ({
    capturePolicy: {
      categories: { ...DEFAULT_CAPTURE_POLICY.categories, screenshots, screenRecordings }
    }
  });

  it("reports the visuals the session's config allows", () => {
    expect(capturedVisualsOf(categories("allow", "allow"))).toEqual({
      screenshots: true,
      screenRecordings: true
    });
    expect(capturedVisualsOf(categories("off", "off"))).toEqual({
      screenshots: false,
      screenRecordings: false
    });
    expect(capturedVisualsOf({})).toEqual({ screenshots: false, screenRecordings: false });
  });
});
