import type { RawRecorderEvent } from "@webblackbox/recorder";

import {
  createCaptureFallback,
  toCaptureFallbackReason,
  type CaptureFallbackReason
} from "../shared/capture-fallback.js";
import {
  applyEnterprisePolicyToRecorderConfig,
  type EnterpriseRecorderPolicy
} from "../shared/options-storage.js";
import {
  buildProfileRecorderConfig,
  listEnterpriseCappedCategories,
  toArchivedProfileInfo
} from "../shared/profiles/resolve.js";
import { withSessionCapturePolicy } from "./profile-reevaluation.js";
import type { SessionRuntime } from "./session-registry.js";

export type CaptureFallbackDeps = {
  /** Resolves when the tab still exists; a closed tab ends the recording instead. */
  tabExists: (tabId: number) => Promise<boolean>;
  loadEnterprisePolicy: () => Promise<EnterpriseRecorderPolicy>;
  /** Detaches what is left of the debugger and clears the Full-only timers. */
  cleanupCdp: (runtime: SessionRuntime) => Promise<void>;
  /** The browser-side network baseline the Light engine records requests with. */
  installLiteNetwork: () => void;
  ingestRawEvent: (rawEvent: RawRecorderEvent) => void;
  monotonicTime: () => number;
  /** Tells the page, the popup and the badge that the recording now runs in Light. */
  announce: (runtime: SessionRuntime) => Promise<void>;
  stopSession: (tabId: number) => Promise<void>;
};

export type CaptureFallbackController = {
  /**
   * Switches a Full recording to page-side (Light) capture and records when and why in the
   * archive. Does nothing for a recording that is not in Full, is stopping, or fell back already.
   */
  fallBackToLite: (
    runtime: SessionRuntime,
    reason: CaptureFallbackReason,
    detail?: string
  ) => Promise<void>;
  /** `chrome.debugger.onDetach` for a recorded tab: Light for a tab that stays, else Stop. */
  handleDebuggerDetach: (runtime: SessionRuntime, detachReason: string) => Promise<void>;
};

export function createCaptureFallbackController(
  deps: CaptureFallbackDeps
): CaptureFallbackController {
  async function fallBackToLite(
    runtime: SessionRuntime,
    reason: CaptureFallbackReason,
    detail?: string
  ): Promise<void> {
    if (!canFallBack(runtime)) {
      return;
    }

    const fallback = createCaptureFallback({
      at: Date.now(),
      reason,
      ...(detail ? { detail } : {})
    });
    // Set first: a detach that races an attach failure falls back once.
    runtime.captureFallback = fallback;
    console.warn(`[WebBlackbox] recording ${runtime.sid} continues in Light: ${reason}`, detail);

    await deps.cleanupCdp(runtime).catch((error: unknown) => {
      console.warn("[WebBlackbox] failed to clean up the debugger after a fallback", error);
    });

    const { selection } = runtime.profile;
    const profileConfig = buildProfileRecorderConfig({
      mode: "lite",
      profile: selection.profile,
      visualCapture: runtime.profile.visualCapture
    });
    const config = applyEnterprisePolicyToRecorderConfig(
      withSessionCapturePolicy(profileConfig, {
        tabId: runtime.tabId,
        origin: runtime.scopeOrigin ?? "",
        startedAt: runtime.startedAt
      }),
      await deps.loadEnterprisePolicy()
    );

    // Stop may have come in while the debugger was cleaned up or the policy read: a finished
    // recording must not switch engines or reinstall the Light network baseline.
    if (isFinishing(runtime)) {
      return;
    }

    runtime.mode = "lite";
    runtime.config = config;
    // Later profile checks compare Light against Light: the fallback is no profile edit.
    runtime.profile = { ...runtime.profile, profileConfig };
    runtime.recorder.reconfigure({ ...config, mode: "lite" });
    deps.installLiteNetwork();
    deps.ingestRawEvent({
      source: "system",
      rawType: "config",
      sid: runtime.sid,
      tabId: runtime.tabId,
      t: fallback.at,
      mono: deps.monotonicTime(),
      payload: {
        ...config,
        profile: toArchivedProfileInfo(
          selection,
          listEnterpriseCappedCategories(profileConfig, config)
        ),
        captureFallback: fallback
      }
    });

    await deps.announce(runtime);
  }

  async function handleDebuggerDetach(
    runtime: SessionRuntime,
    detachReason: string
  ): Promise<void> {
    if (!canFallBack(runtime)) {
      return;
    }

    const reason = toCaptureFallbackReason(detachReason);

    if (reason === "target-closed" && !(await deps.tabExists(runtime.tabId))) {
      await deps.stopSession(runtime.tabId);
      return;
    }

    if (isFinishing(runtime)) {
      return;
    }

    deps.ingestRawEvent({
      source: "system",
      rawType: "debugger-detach",
      sid: runtime.sid,
      tabId: runtime.tabId,
      t: Date.now(),
      mono: deps.monotonicTime(),
      payload: { reason: detachReason }
    });
    await fallBackToLite(runtime, reason, detachReason);
  }

  return { fallBackToLite, handleDebuggerDetach };
}

function canFallBack(runtime: SessionRuntime): boolean {
  return runtime.mode === "full" && !runtime.captureFallback && !isFinishing(runtime);
}

function isFinishing(runtime: SessionRuntime): boolean {
  return runtime.stopping === true || runtime.stoppedAt !== undefined;
}
