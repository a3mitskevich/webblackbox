import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  type CapturePolicy
} from "@webblackbox/protocol";
import type { RawRecorderEvent } from "@webblackbox/recorder";

import type { ChromeApi } from "../shared/chrome-api.js";
import type { ProfilePreviewResponse } from "../shared/messages.js";
import {
  applyEnterprisePolicyToRecorderConfig,
  ENTERPRISE_POLICY_STORAGE_KEY,
  normalizeEnterprisePolicy,
  type EnterpriseRecorderPolicy
} from "../shared/options-storage.js";
import {
  AUTO_PROFILE_ID,
  buildProfileRecorderConfig,
  listEnterpriseCappedCategories,
  selectRecordingProfile,
  type ProfileSelection
} from "../shared/profiles/resolve.js";
import type { ProfilesState } from "../shared/profiles/storage.js";
import {
  buildProfileCancellation,
  detectProfileChange,
  reselectStartedProfile,
  shouldDeferProfileCheck,
  type ProfileCancellation,
  type ProfileCancelTrigger,
  type SessionProfileSnapshot
} from "./profile-change.js";
import {
  buildProfilePreview,
  isTabLoading,
  loadProfilesState,
  readTabPageContext
} from "./profile-runtime.js";
import type { SessionRuntime } from "./session-registry.js";

export type ProfileReevaluationDeps = {
  chromeApi: ChromeApi | null;
  /** v1 options move into the profiles store once; profile reads wait for it. */
  settingsMigrated: Promise<unknown>;
  readEnterprisePolicy: () => Promise<Record<string, unknown> | null>;
  resolveUiActionTarget: (
    requestedTabId: number | undefined,
    senderTabId: number | undefined
  ) => Promise<number | undefined>;
  ingestRawEvent: (rawEvent: RawRecorderEvent) => void;
  stopSession: (tabId: number) => Promise<void>;
  monotonicTime: () => number;
};

export type ProfileReevaluationController = {
  loadSessionProfilesState: () => Promise<ProfilesState>;
  loadEnterprisePolicy: () => Promise<EnterpriseRecorderPolicy>;
  /** Resolves the profile for a tab from the current store, rules and page signals. */
  resolveTabProfileSelection: (tabId: number, request: string) => Promise<ProfileSelection | null>;
  resolveProfilePreview: (
    requestedTabId: number | undefined,
    senderTabId: number | undefined,
    requestedProfileId: string | undefined
  ) => Promise<ProfilePreviewResponse>;
  scheduleProfileReevaluation: (runtime: SessionRuntime, trigger: ProfileCancelTrigger) => void;
};

/**
 * Applies the session's tab/origin/start time to a recorder config's capture policy: consent
 * timestamp, scope binding, and a per-session `stopOnOriginChange` reset.
 */
export function withSessionCapturePolicy(
  config: typeof DEFAULT_RECORDER_CONFIG,
  context: {
    tabId: number;
    origin: string;
    startedAt: number;
  }
): typeof DEFAULT_RECORDER_CONFIG {
  const basePolicy =
    config.capturePolicy ?? DEFAULT_RECORDER_CONFIG.capturePolicy ?? DEFAULT_CAPTURE_POLICY;
  const capturePolicy: CapturePolicy = {
    ...basePolicy,
    consent: {
      ...basePolicy.consent,
      grantedAt: new Date(context.startedAt).toISOString()
    },
    scope: {
      ...basePolicy.scope,
      tabId: context.tabId,
      origin: context.origin,
      allowedOrigins: [...basePolicy.scope.allowedOrigins],
      stopOnOriginChange: false
    },
    redaction: config.redaction
  };

  return {
    ...config,
    capturePolicy
  };
}

/**
 * Re-runs the profile rules after navigation, page load or a settings change. A session records
 * with one profile: when the effective profile is no longer the one it started with, the
 * recording is cancelled (what was captured stays for export or deletion).
 *
 * Re-evaluations serialize per session and only the latest request runs: older queued or
 * in-flight ones are dropped, so a navigation burst costs one page probe, not one per step.
 */
export function createProfileReevaluation(
  deps: ProfileReevaluationDeps
): ProfileReevaluationController {
  async function loadSessionProfilesState(): Promise<ProfilesState> {
    await deps.settingsMigrated;
    return loadProfilesState(
      deps.chromeApi,
      { enterprisePolicyKey: ENTERPRISE_POLICY_STORAGE_KEY },
      deps.readEnterprisePolicy
    );
  }

  async function loadEnterprisePolicy(): Promise<EnterpriseRecorderPolicy> {
    return normalizeEnterprisePolicy((await deps.readEnterprisePolicy()) ?? {});
  }

  async function resolveTabProfileSelection(
    tabId: number,
    request: string
  ): Promise<ProfileSelection | null> {
    const state = await loadSessionProfilesState();
    const page = (await readTabPageContext(deps.chromeApi, tabId, state.rules)) ?? {
      url: `tab:${tabId}`
    };

    return selectRecordingProfile({ state, page, requestedProfileId: request });
  }

  async function resolveProfilePreview(
    requestedTabId: number | undefined,
    senderTabId: number | undefined,
    requestedProfileId: string | undefined
  ): Promise<ProfilePreviewResponse> {
    const state = await loadSessionProfilesState();
    // The same tab `ui.start` would record, so the preview shows the profile Start applies.
    const tabId = await deps.resolveUiActionTarget(requestedTabId, senderTabId);

    if (typeof tabId !== "number") {
      return buildProfilePreview(state, null);
    }

    const page = await readTabPageContext(deps.chromeApi, tabId, state.rules);
    const selection = page
      ? selectRecordingProfile({
          state,
          page,
          requestedProfileId: requestedProfileId ?? AUTO_PROFILE_ID
        })
      : null;

    if (!selection) {
      return buildProfilePreview(state, null);
    }

    // The preview renders the profile on its recommended transport to name the enterprise caps.
    const profileConfig = buildProfileRecorderConfig({
      mode: selection.profile.base,
      profile: selection.profile
    });
    const effectiveConfig = applyEnterprisePolicyToRecorderConfig(
      profileConfig,
      await loadEnterprisePolicy()
    );

    return buildProfilePreview(
      state,
      selection,
      listEnterpriseCappedCategories(profileConfig, effectiveConfig)
    );
  }

  function scheduleProfileReevaluation(
    runtime: SessionRuntime,
    trigger: ProfileCancelTrigger
  ): void {
    const generation = nextProfileGeneration(runtime);

    runtime.profile.reevaluation = runtime.profile.reevaluation
      .then(() => reevaluateSessionProfile(runtime, trigger, generation))
      .catch((error) => {
        console.warn("[WebBlackbox] recording profile re-evaluation failed", error);
      });
  }

  function nextProfileGeneration(runtime: SessionRuntime): number {
    const generation = runtime.profile.generation + 1;
    runtime.profile = { ...runtime.profile, generation };
    return generation;
  }

  function isProfileRequestCurrent(runtime: SessionRuntime, generation: number): boolean {
    return runtime.profile.generation === generation && !runtime.stopping && !runtime.stoppedAt;
  }

  /**
   * A session records with one profile: when the effective profile is no longer the one it
   * started with (another profile picked by the rules, the profile deleted or edited, the
   * enterprise policy changed), the recording is cancelled. What was captured is kept for export
   * or deletion, and the popup explains why and how to fix it.
   */
  async function reevaluateSessionProfile(
    runtime: SessionRuntime,
    trigger: ProfileCancelTrigger,
    generation: number
  ): Promise<void> {
    if (!isProfileRequestCurrent(runtime, generation)) {
      return;
    }

    const [state, enterprisePolicy, tabLoading] = await Promise.all([
      loadSessionProfilesState(),
      loadEnterprisePolicy(),
      isTabLoading(deps.chromeApi, runtime.tabId)
    ]);

    // Rules that read the page cannot match before it loads; the page-loaded check decides.
    if (shouldDeferProfileCheck({ trigger, tabLoading, rules: state.rules })) {
      return;
    }

    const page = await readTabPageContext(deps.chromeApi, runtime.tabId, state.rules, {
      requireSignals: true
    });

    const started = runtime.profile.selection;
    // A tab or page that cannot be read right now says nothing about the rules: only the started
    // profile itself is checked (deleted, edited or capped by the policy).
    const nextSelection = page
      ? selectRecordingProfile({ state, page, requestedProfileId: runtime.profile.request })
      : reselectStartedProfile(started, state);
    const next = nextSelection
      ? await buildSessionProfileSnapshot(runtime, nextSelection, enterprisePolicy)
      : null;

    // The session may have stopped or a newer request may have landed while this one was loading.
    if (!isProfileRequestCurrent(runtime, generation)) {
      return;
    }

    const reason = detectProfileChange({
      started: {
        selection: started,
        profileConfig: runtime.profile.profileConfig,
        effectiveConfig: runtime.config
      },
      next,
      startedProfileExists: state.catalog.some((profile) => profile.id === started.profile.id)
    });

    if (reason) {
      await cancelSessionForProfileChange(
        runtime,
        buildProfileCancellation({
          reason,
          trigger,
          at: Date.now(),
          started,
          next: nextSelection
        })
      );
    }
  }

  /** The recorder configs a selection would run with in this session. */
  async function buildSessionProfileSnapshot(
    runtime: SessionRuntime,
    selection: ProfileSelection,
    enterprisePolicy: EnterpriseRecorderPolicy
  ): Promise<SessionProfileSnapshot> {
    const profileConfig = buildProfileRecorderConfig({
      mode: runtime.mode,
      profile: selection.profile,
      visualCapture: runtime.profile.visualCapture
    });
    const effectiveConfig = applyEnterprisePolicyToRecorderConfig(
      withSessionCapturePolicy(profileConfig, {
        tabId: runtime.tabId,
        origin: runtime.scopeOrigin ?? "",
        startedAt: runtime.startedAt
      }),
      enterprisePolicy
    );

    return { selection, profileConfig, effectiveConfig };
  }

  /**
   * Records why the profile changed (`meta.config.profileCancel`), then stops the session like
   * the Stop button does: the data stays for export or deletion. The badge and the popup tell
   * the user.
   */
  async function cancelSessionForProfileChange(
    runtime: SessionRuntime,
    cancellation: ProfileCancellation
  ): Promise<void> {
    runtime.profile = { ...runtime.profile, cancellation, cancellationAcknowledged: false };
    deps.ingestRawEvent({
      source: "system",
      rawType: "config",
      sid: runtime.sid,
      tabId: runtime.tabId,
      t: cancellation.at,
      mono: deps.monotonicTime(),
      payload: {
        ...runtime.config,
        profile: cancellation.started,
        profileCancel: cancellation
      }
    });
    console.warn(
      `[WebBlackbox] recording ${runtime.sid} stopped: profile changed (${cancellation.reason})`
    );

    // Stopping updates the badge to `!` while the notice is unread.
    await deps.stopSession(runtime.tabId);
  }

  return {
    loadSessionProfilesState,
    loadEnterprisePolicy,
    resolveTabProfileSelection,
    resolveProfilePreview,
    scheduleProfileReevaluation
  };
}
