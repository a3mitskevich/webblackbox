import { sanitizeUrlForPrivacy, type WebBlackboxEvent } from "@webblackbox/protocol";

import type {
  ChromeApi,
  ChromeTabChangeInfo,
  FrameCommittedDetails
} from "../shared/chrome-api.js";
import { isEnterpriseOriginAllowed } from "../shared/options-storage.js";
import type { StorageArtifactsController } from "./artifacts-storage.js";
import {
  shouldStopForCaptureScopeOriginChange,
  shouldStopForEnterpriseOriginPolicy as shouldStopForEnterpriseOriginPolicyInput
} from "./capture-scope.js";
import {
  injectContentScriptIntoFrame,
  isInjectableFrameUrl,
  type ContentInjectionController
} from "./content-injection.js";
import { shouldUpdateSessionMetadataFromNavigation } from "./navigation-metadata.js";
import type { ProfileReevaluationController } from "./profile-reevaluation.js";
import {
  ensureContentScriptInjected,
  ensureInjectedHooks,
  toStatusPointer,
  toStatusSampling,
  type ScriptingApiLike
} from "./recording-status.js";
import type { SessionCommandsController } from "./session-commands.js";
import { resolveUrlOrigin, type SessionRegistry, type SessionRuntime } from "./session-registry.js";
import type { TabsContextTracker } from "./tabs-context/tracker.js";

export type NavigationRouterRuntimeApi = Pick<NonNullable<ChromeApi["runtime"]>, "getManifest">;

export type NavigationRouterDeps = {
  sessionRegistry: SessionRegistry;
  sessionCommands: Pick<SessionCommandsController, "stopSession" | "notifyTabStatus">;
  profile: ProfileReevaluationController;
  contentInjection: Pick<ContentInjectionController, "currentMode">;
  storageArtifacts: Pick<StorageArtifactsController, "rememberVisitedPageUrl">;
  tabsContextTracker: TabsContextTracker | null;
  runtime: NavigationRouterRuntimeApi | undefined;
  scripting: ScriptingApiLike | undefined;
  pushSessionList: () => void;
};

export type NavigationRouter = {
  handleRecordedTabUpdated: (tabId: number, changeInfo: ChromeTabChangeInfo) => void;
  handleRecordedFrameCommitted: (details: FrameCommittedDetails) => void;
  updateSessionMetadataFromEvent: (runtime: SessionRuntime, event: WebBlackboxEvent) => void;
};

/**
 * Navigation routing for recorded tabs: a URL change re-applies the capture scope (the session
 * stops when the origin or the enterprise policy forbids the new one), a completed navigation
 * restores the tab's instrumentation and re-checks the recording profile, and navigation events
 * keep the session metadata on the page the recording shows.
 */
export function createNavigationRouter(deps: NavigationRouterDeps): NavigationRouter {
  const { sessionRegistry } = deps;

  function handleRecordedTabUpdated(tabId: number, changeInfo: ChromeTabChangeInfo): void {
    if (typeof changeInfo.url === "string" && changeInfo.url.length > 0) {
      void handleTabUrlChanged(tabId, changeInfo.url);
    }

    if (changeInfo.status === "complete") {
      void restoreTabInstrumentationAfterNavigation(tabId);
    }
  }

  /**
   * With injection on Start only, nothing registered covers a recorded tab's new documents, so
   * each committed frame (reload, navigation, iframe added later) gets the content script right
   * away.
   */
  function handleRecordedFrameCommitted(details: FrameCommittedDetails): void {
    const runtime = sessionRegistry.getByTab(details.tabId);

    if (
      !runtime ||
      runtime.stopping ||
      runtime.stoppedAt ||
      deps.contentInjection.currentMode() !== "on-start" ||
      !isInjectableFrameUrl(details.url)
    ) {
      return;
    }

    void injectContentScriptIntoFrame(
      { scripting: deps.scripting },
      details.tabId,
      details.frameId
    );
  }

  async function restoreTabInstrumentationAfterNavigation(tabId: number): Promise<void> {
    const runtime = sessionRegistry.getByTab(tabId);

    if (!runtime || runtime.stopping || runtime.stoppedAt) {
      return;
    }

    await ensureContentScriptInjected(deps.scripting, tabId);
    await ensureInjectedHooks(deps.scripting, tabId, runtime.injectedBridgeNonce);
    await deps.sessionCommands.notifyTabStatus(
      tabId,
      true,
      runtime.sid,
      runtime.mode,
      toStatusSampling(runtime),
      runtime.config.capturePolicy,
      runtime.injectedBridgeNonce,
      toStatusPointer(runtime)
    );
    // Title, meta tags and selectors are only reliable once the page has loaded.
    deps.profile.scheduleProfileReevaluation(runtime, "page-loaded");
  }

  async function handleTabUrlChanged(tabId: number, rawUrl: string): Promise<void> {
    const runtime = sessionRegistry.getByTab(tabId);

    if (!runtime || runtime.stoppedAt) {
      return;
    }

    const nextUrl = sanitizeUrlForPrivacy(rawUrl);
    const nextOrigin = resolveUrlOrigin(nextUrl);

    if (shouldStopOnOriginChange(runtime, nextOrigin)) {
      await deps.sessionCommands.stopSession(tabId);
      return;
    }

    if (await shouldStopForEnterpriseOriginPolicy(nextOrigin)) {
      await deps.sessionCommands.stopSession(tabId);
      return;
    }

    if (nextUrl !== runtime.url) {
      runtime.url = nextUrl;
      deps.pushSessionList();
    }

    // Relations to other tabs are computed against the recorded tab's origin.
    void deps.tabsContextTracker?.updateSession(tabId, { url: rawUrl });
    deps.storageArtifacts.rememberVisitedPageUrl(runtime, rawUrl);

    deps.profile.scheduleProfileReevaluation(runtime, "navigation");
  }

  function shouldStopOnOriginChange(runtime: SessionRuntime, nextOrigin: string | null): boolean {
    return shouldStopForCaptureScopeOriginChange({
      scopeOrigin: runtime.scopeOrigin,
      nextOrigin,
      stopOnOriginChange: runtime.config.capturePolicy?.scope.stopOnOriginChange === true,
      activeTabScopedBuild: isActiveTabScopedBuild()
    });
  }

  async function shouldStopForEnterpriseOriginPolicy(nextOrigin: string | null): Promise<boolean> {
    const enterprisePolicy = await deps.profile.loadEnterprisePolicy();

    return shouldStopForEnterpriseOriginPolicyInput({
      nextOrigin,
      isEnterpriseOriginAllowed: (origin) => isEnterpriseOriginAllowed(origin, enterprisePolicy)
    });
  }

  function isActiveTabScopedBuild(): boolean {
    const manifest = deps.runtime?.getManifest?.();
    const permissions = new Set(manifest?.permissions ?? []);
    const hostPermissions = manifest?.host_permissions ?? [];

    return permissions.has("activeTab") && hostPermissions.length === 0;
  }

  function updateSessionMetadataFromEvent(runtime: SessionRuntime, event: WebBlackboxEvent): void {
    void updateSessionMetadataFromEventAsync(runtime, event).catch((error) => {
      console.warn("[WebBlackbox] failed to update session navigation metadata", error);
    });
  }

  async function updateSessionMetadataFromEventAsync(
    runtime: SessionRuntime,
    event: WebBlackboxEvent
  ): Promise<void> {
    if (
      event.type !== "nav.commit" &&
      event.type !== "nav.history.push" &&
      event.type !== "nav.history.replace" &&
      event.type !== "nav.hash"
    ) {
      return;
    }

    const payload = asRecord(event.data);

    if (!shouldUpdateSessionMetadataFromNavigation(event, payload)) {
      return;
    }

    const frame = asRecord(payload?.frame);
    const nextUrl = asString(payload?.url) ?? asString(frame?.url);
    const nextTitle = asString(payload?.title) ?? asString(payload?.documentTitle);
    let changed = false;

    const sanitizedNextUrl = nextUrl ? sanitizeUrlForPrivacy(nextUrl) : undefined;

    if (sanitizedNextUrl && sanitizedNextUrl !== runtime.url) {
      const nextOrigin = resolveUrlOrigin(sanitizedNextUrl);

      if (shouldStopOnOriginChange(runtime, nextOrigin)) {
        await deps.sessionCommands.stopSession(runtime.tabId);
        return;
      }

      if (await shouldStopForEnterpriseOriginPolicy(nextOrigin)) {
        await deps.sessionCommands.stopSession(runtime.tabId);
        return;
      }

      runtime.url = sanitizedNextUrl;
      changed = true;
    }

    if (nextTitle && nextTitle.trim().length > 0 && nextTitle !== runtime.title) {
      runtime.title = nextTitle.trim();
      changed = true;
    }

    if (changed) {
      deps.pushSessionList();
    }
  }

  return {
    handleRecordedTabUpdated,
    handleRecordedFrameCommitted,
    updateSessionMetadataFromEvent
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
