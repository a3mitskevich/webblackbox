import { sanitizeUrlForPrivacy, type SessionMetadata } from "@webblackbox/protocol";

import type {
  ExtensionOutboundMessage,
  SessionListItem,
  SessionListMessage
} from "../shared/messages.js";
import { toProfileCancelNotice } from "./profile-change.js";
import type { SessionRegistry, SessionRuntime } from "./session-registry.js";

export type SessionListViewDeps = {
  sessionRegistry: SessionRegistry;
  broadcast: (message: ExtensionOutboundMessage) => void;
};

export type SessionListView = {
  /** Every known session, active first, then newest first, as the popup lists them. */
  buildSessionListMessage: () => SessionListMessage;
  broadcastSessionList: () => void;
};

export function toSessionMetadata(runtime: SessionRuntime): SessionMetadata {
  return {
    sid: runtime.sid,
    tabId: runtime.tabId,
    startedAt: runtime.startedAt,
    mode: runtime.mode,
    url: sanitizeUrlForPrivacy(runtime.url),
    title: runtime.title,
    tags: [...runtime.tags]
  };
}

function toSessionListItem(
  sessionRegistry: SessionRegistry,
  runtime: SessionRuntime
): SessionListItem {
  const activeRuntime = sessionRegistry.getByTab(runtime.tabId);
  const active = activeRuntime?.sid === runtime.sid;

  return {
    sid: runtime.sid,
    tabId: runtime.tabId,
    mode: runtime.mode,
    startedAt: runtime.startedAt,
    active,
    stoppedAt: runtime.stoppedAt,
    url: sanitizeUrlForPrivacy(runtime.url),
    title: runtime.title,
    eventCount: runtime.capturedEventCount,
    errorCount: runtime.capturedErrorCount,
    budgetAlertCount: runtime.budgetAlertCount,
    sizeBytes: runtime.capturedSizeBytes,
    tags: [...runtime.tags],
    note: runtime.note,
    profileName: runtime.profile.selection.profile.name,
    ...(runtime.profile.cancellation && !runtime.profile.cancellationAcknowledged
      ? { profileCancel: toProfileCancelNotice(runtime.profile.cancellation) }
      : {})
  };
}

/** The session list the popup, options and sessions pages render. */
export function createSessionListView(deps: SessionListViewDeps): SessionListView {
  function buildSessionListMessage(): SessionListMessage {
    const sessions: SessionListItem[] = [...deps.sessionRegistry.sidRuntimes()]
      .map((runtime) => toSessionListItem(deps.sessionRegistry, runtime))
      .sort((left, right) => {
        const activeDiff = Number(right.active) - Number(left.active);

        if (activeDiff !== 0) {
          return activeDiff;
        }

        return right.startedAt - left.startedAt;
      });

    return {
      kind: "sw.session-list",
      sessions
    };
  }

  return {
    buildSessionListMessage,
    broadcastSessionList: () => {
      deps.broadcast(buildSessionListMessage());
    }
  };
}
