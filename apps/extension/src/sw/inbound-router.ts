import type { RawRecorderEvent } from "@webblackbox/recorder";

import type { PortLike, RuntimeMessageSender } from "../shared/chrome-api.js";
import {
  PORT_NAMES,
  type ExtensionInboundMessage,
  type FullModeVisualCapture
} from "../shared/messages.js";
import type { SwPipelineStatusMessage } from "../shared/offscreen-messages.js";
import type { ScreenRecordingController } from "./artifacts-screen-recording.js";
import { isOffscreenDocumentPort } from "./at-rest-key.js";
import type { ChromeApi } from "../shared/chrome-api.js";
import type { SessionExportController } from "./export-session.js";
import { toScriptScanStatus } from "./full-cdp.js";
import {
  OFFSCREEN_DISCONNECTED_ERROR,
  type OffscreenClient,
  type OffscreenEventMessage
} from "./offscreen-client.js";
import { logPortSendFailure, type PortRegistry } from "./port-registry.js";
import {
  classifyMessageSender,
  classifyPortSender,
  isInboundKindAllowed,
  type InboundSenderContext,
  type SenderTrustContext
} from "./port-sender.js";
import type { ProfileReevaluationController } from "./profile-reevaluation.js";
import {
  ensureInjectedHooks,
  toStatusPointer,
  toStatusSampling,
  type ScriptingApiLike
} from "./recording-status.js";
import type { SessionAnnotationsController } from "./session-annotations.js";
import type { SessionCommandsController } from "./session-commands.js";
import type { SessionListView } from "./session-list.js";
import type { SessionRegistry } from "./session-registry.js";
import { startWithOptionalReload } from "./start-with-reload.js";
import type { StopDrainTracker } from "./stop-drain.js";

/** Time slice a `content.events` batch gets before the loop yields to other tasks. */
const CONTENT_EVENT_SLICE_BUDGET_MS = 8;

export type InboundRouterRuntimeApi = Pick<NonNullable<ChromeApi["runtime"]>, "id" | "getURL">;
export type InboundRouterTabsApi = Pick<NonNullable<ChromeApi["tabs"]>, "query" | "sendMessage">;

export type InboundRouterDeps = {
  sessionRegistry: SessionRegistry;
  portRegistry: PortRegistry;
  stopDrain: StopDrainTracker;
  offscreenClient: OffscreenClient;
  screenRecording: Pick<
    ScreenRecordingController,
    | "handleOffscreenScreenRecordingChunk"
    | "handleOffscreenScreenRecordingEnded"
    | "handleOffscreenScreenRecordingError"
  >;
  sessionCommands: SessionCommandsController;
  sessionList: SessionListView;
  sessionExport: SessionExportController;
  annotations: SessionAnnotationsController;
  profile: ProfileReevaluationController;
  runtime: InboundRouterRuntimeApi | undefined;
  tabs: InboundRouterTabsApi | undefined;
  scripting: ScriptingApiLike | undefined;
  /** Path of the offscreen document within the extension, for the sender trust check. */
  offscreenPath: string;
  resolveUiActionTarget: (
    requestedTabId: number | undefined,
    senderTabId: number | undefined
  ) => Promise<number | undefined>;
  ingestRawEvent: (rawEvent: RawRecorderEvent) => void;
  sendAtRestKeyToOffscreen: (port: PortLike) => Promise<void>;
  recoverActiveOffscreenPipelines: () => Promise<void>;
  markStoppedPipelinesDetached: () => void;
  /** A message may be what woke this worker: answer once the previous state is restored. */
  waitForRuntimeState: () => Promise<unknown>;
  pushSessionList: () => void;
  wait: (durationMs: number) => Promise<void>;
  monotonicTime: () => number;
  perfNow: () => number;
  shouldLogPortDebug: () => boolean;
};

export type InboundRouter = {
  /** The `runtime.onConnect` entry: trust check, bookkeeping, per-port message wiring. */
  handlePortConnect: (port: PortLike) => void;
  /**
   * The `runtime.onMessage` entry. Returns true when a response is sent asynchronously (the
   * message was parsed and its kind is allowed for the sender), undefined otherwise.
   */
  handleRuntimeMessage: (
    rawMessage: unknown,
    sender: RuntimeMessageSender,
    sendResponse: (response: unknown) => void
  ) => boolean;
  /** The `mark-bug` keyboard command, relayed to the active tab's content script. */
  relayMarkerCommand: () => Promise<void>;
  notifyOffscreenPipelineStatus: () => void;
};

/**
 * Routes everything that reaches the service worker: extension ports and one-shot runtime
 * messages are trust-checked, parsed and dispatched to the session commands, the export flow,
 * the annotations store and the raw-event ingest; the offscreen document's port carries pipeline
 * events to the offscreen client.
 */
export function createInboundRouter(deps: InboundRouterDeps): InboundRouter {
  const { sessionRegistry, portRegistry, stopDrain } = deps;

  function handlePortConnect(port: PortLike): void {
    if (
      !Object.values(PORT_NAMES).includes(port.name as (typeof PORT_NAMES)[keyof typeof PORT_NAMES])
    ) {
      return;
    }

    const senderContext = resolvePortSenderContext(port);

    if (senderContext === "untrusted") {
      // Port names are chosen by the connecting script: never let an arbitrary frame
      // claim the offscreen pipeline or receive session broadcasts.
      console.warn("[WebBlackbox] rejected port from untrusted sender", {
        portName: port.name,
        tabId: port.sender?.tab?.id,
        frameId: port.sender?.frameId
      });
      port.disconnect?.();
      return;
    }

    // The offscreen port carries the at-rest key and every recorded event: only the extension's
    // own offscreen document may take it. The sender check above already covers this; the
    // explicit check keeps the key from depending on that classification alone.
    if (port.name === PORT_NAMES.offscreen && !isTrustedOffscreenPort(port)) {
      console.warn("[WebBlackbox] refused an offscreen port from another context", {
        tabId: port.sender?.tab?.id
      });
      port.disconnect?.();
      return;
    }

    portRegistry.addPort(port);

    if (port.name === PORT_NAMES.offscreen) {
      portRegistry.setOffscreenPort(port);
      void deps.sendAtRestKeyToOffscreen(port);
      notifyOffscreenPipelineStatus();
    }

    if (port.name === PORT_NAMES.content) {
      void syncContentPortStateOnConnect(port).catch((error) => {
        logInboundMessageFailure("content.connect", error, port);
      });
    }

    deps.pushSessionList();

    const onMessage = (rawMessage: unknown) => {
      if (handleOffscreenRuntimeMessage(rawMessage, port)) {
        return;
      }

      const message = parseInboundMessage(rawMessage);

      if (!message || !isInboundKindAllowed(message.kind, senderContext)) {
        return;
      }

      dispatchInboundMessage(message, port);
    };

    const onDisconnect = () => {
      portRegistry.removePort(port);

      if (portRegistry.clearOffscreenPort(port)) {
        deps.offscreenClient.rejectPending(OFFSCREEN_DISCONNECTED_ERROR);
        deps.markStoppedPipelinesDetached();

        if (sessionRegistry.tabCount() > 0) {
          void deps.recoverActiveOffscreenPipelines().catch((error) => {
            console.warn("[WebBlackbox] failed to recover active offscreen pipelines", error);
          });
        }
      }

      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
    };

    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
  }

  function handleRuntimeMessage(
    rawMessage: unknown,
    sender: RuntimeMessageSender,
    sendResponse: (response: unknown) => void
  ): boolean {
    const message = parseInboundMessage(rawMessage);

    if (!message || !isInboundKindAllowed(message.kind, resolveMessageSenderContext(sender))) {
      return false;
    }

    void handleInboundMessage(message, undefined, sender.tab?.id, sender.frameId)
      .then((result) => {
        sendResponse(result ?? { ok: true });
      })
      .catch((error) => {
        logInboundMessageFailure(message.kind, error, undefined, {
          tabId: sender.tab?.id,
          frameId: sender.frameId
        });
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      });

    return true;
  }

  function dispatchInboundMessage(
    message: ExtensionInboundMessage,
    port?: PortLike,
    senderTabId?: number,
    senderFrameId?: number
  ): void {
    void handleInboundMessage(message, port, senderTabId, senderFrameId).catch((error) => {
      logInboundMessageFailure(message.kind, error, port, {
        tabId: senderTabId,
        frameId: senderFrameId
      });
    });
  }

  async function handleInboundMessage(
    message: ExtensionInboundMessage,
    port?: PortLike,
    senderTabId?: number,
    senderFrameId?: number
  ): Promise<unknown> {
    // A message may be what woke this worker: answer it once an earlier worker's stopped
    // recordings are restored, so they are listed and exportable.
    await deps.waitForRuntimeState();

    if (message.kind === "ui.start") {
      const tabId = await deps.resolveUiActionTarget(message.tabId, senderTabId);

      if (typeof tabId !== "number") {
        return;
      }

      // Both engines: the reload follows the start, so the capture (Full: CDP) sees the page
      // load.
      await startWithOptionalReload(tabId, message.reloadPage === true, {
        start: () =>
          deps.sessionCommands.startSession(tabId, message.mode, {
            visualCapture: resolveFullModeVisualCapture(message),
            profileId: typeof message.profileId === "string" ? message.profileId : undefined
          }),
        reload: deps.sessionCommands.reloadRecordingTab,
        stop: deps.sessionCommands.stopSession
      });
      return;
    }

    if (message.kind === "ui.stop") {
      const tabId = await deps.resolveUiActionTarget(message.tabId, senderTabId);

      if (typeof tabId !== "number") {
        return;
      }

      await deps.sessionCommands.stopSession(tabId);
      return;
    }

    if (message.kind === "ui.export") {
      return deps.sessionExport.exportSession(
        message.sid,
        message.passphrase,
        message.saveAs,
        deps.sessionExport.resolveExportPolicy(message.policy)
      );
    }

    if (message.kind === "ui.resolve-profile") {
      const preview = await deps.profile.resolveProfilePreview(
        message.tabId,
        senderTabId,
        message.profileId
      );

      if (port) {
        portRegistry.sendPortMessage(port, preview);
        return;
      }

      return preview;
    }

    if (message.kind === "ui.delete") {
      await deps.sessionCommands.deleteSessionBySid(message.sid);
      return;
    }

    if (message.kind === "ui.annotate") {
      await deps.annotations.update(message.sid, message.tags, message.note);
      return;
    }

    if (message.kind === "ui.ack-profile-cancel") {
      await deps.sessionCommands.acknowledgeProfileCancel(message.sid);
      return;
    }

    if (message.kind === "ui.request-session-list") {
      const sessionList = deps.sessionList.buildSessionListMessage();

      if (port) {
        portRegistry.sendPortMessage(port, sessionList);
        return;
      }

      return sessionList;
    }

    if (message.kind === "content.marker") {
      const tabId = senderTabId ?? port?.sender?.tab?.id;
      const frame = normalizeContentFrameId(senderFrameId ?? port?.sender?.frameId);

      if (typeof tabId === "number") {
        deps.ingestRawEvent({
          source: "content",
          rawType: "marker",
          tabId,
          sid: sessionRegistry.getByTab(tabId)?.sid ?? "",
          t: Date.now(),
          mono: deps.monotonicTime(),
          frame,
          payload: {
            message: message.message
          }
        });
      }

      return;
    }

    if (message.kind === "content.ready") {
      const tabId = senderTabId ?? port?.sender?.tab?.id;

      if (typeof tabId !== "number") {
        return {
          kind: "sw.recording-status",
          active: false
        };
      }

      const runtime = sessionRegistry.getByTab(tabId);

      if (!runtime || runtime.stoppedAt) {
        return {
          kind: "sw.recording-status",
          active: false
        };
      }

      // The sender's frame only: the reply below reaches only that frame's content script.
      await ensureInjectedHooks(
        deps.scripting,
        tabId,
        runtime.injectedBridgeNonce,
        senderFrameId ?? port?.sender?.frameId
      );

      const sampling = toStatusSampling(runtime);

      if (port?.name === PORT_NAMES.content) {
        syncContentPortRecordingState(port);
        return {
          ok: true
        };
      }

      return {
        kind: "sw.recording-status",
        active: true,
        sid: runtime.sid,
        mode: runtime.mode,
        sampling,
        capturePolicy: runtime.config.capturePolicy,
        injectedBridgeNonce: runtime.injectedBridgeNonce,
        pointer: toStatusPointer(runtime),
        ...toScriptScanStatus(runtime)
      };
    }

    if (message.kind === "content.stop-drained") {
      stopDrain.markStopDrainAckReceived(message.sid);
      return;
    }

    if (message.kind === "content.events") {
      const tabId = senderTabId ?? port?.sender?.tab?.id;
      const frame = normalizeContentFrameId(senderFrameId ?? port?.sender?.frameId);

      if (
        typeof tabId !== "number" ||
        !Array.isArray(message.events) ||
        message.events.length === 0
      ) {
        return;
      }

      stopDrain.adjustInFlightContentMessages(tabId, 1);
      let sliceStartedAt = deps.perfNow();

      try {
        for (const rawEvent of message.events) {
          deps.ingestRawEvent({
            ...rawEvent,
            tabId,
            frame: rawEvent.frame ?? frame
          });

          if (deps.perfNow() - sliceStartedAt >= CONTENT_EVENT_SLICE_BUDGET_MS) {
            await deps.wait(0);
            sliceStartedAt = deps.perfNow();
          }
        }
      } finally {
        stopDrain.adjustInFlightContentMessages(tabId, -1);
      }
    }
  }

  function resolvePortSenderContext(port: PortLike): InboundSenderContext {
    const trustContext = resolveSenderTrustContext();
    return trustContext ? classifyPortSender(port.name, port.sender, trustContext) : "untrusted";
  }

  function resolveMessageSenderContext(sender: RuntimeMessageSender): InboundSenderContext {
    const trustContext = resolveSenderTrustContext();
    return trustContext ? classifyMessageSender(sender, trustContext) : "untrusted";
  }

  function resolveSenderTrustContext(): SenderTrustContext | null {
    const runtime = deps.runtime;

    if (!runtime?.id || typeof runtime.getURL !== "function") {
      return null;
    }

    return {
      extensionId: runtime.id,
      extensionOrigin: runtime.getURL("").replace(/\/+$/, ""),
      offscreenUrl: runtime.getURL(deps.offscreenPath)
    };
  }

  function isTrustedOffscreenPort(port: PortLike): boolean {
    return isOffscreenDocumentPort(port, deps.runtime?.getURL(deps.offscreenPath) ?? "");
  }

  async function syncContentPortStateOnConnect(port: PortLike): Promise<void> {
    const tabId = port.sender?.tab?.id;

    if (typeof tabId !== "number") {
      return;
    }

    const runtime = sessionRegistry.getByTab(tabId);

    if (!runtime || runtime.stoppedAt) {
      return;
    }

    // Only the connecting frame: re-running the hooks script resets a frame's live capture
    // config (the script installs inactive), and only that frame gets the recording status back
    // below.
    await ensureInjectedHooks(
      deps.scripting,
      tabId,
      runtime.injectedBridgeNonce,
      port.sender?.frameId
    );

    syncContentPortRecordingState(port);
  }

  function syncContentPortRecordingState(port: PortLike): void {
    const tabId = port.sender?.tab?.id;

    if (typeof tabId !== "number") {
      return;
    }

    const runtime = sessionRegistry.getByTab(tabId);

    if (!runtime || runtime.stoppedAt) {
      return;
    }

    const sampling = toStatusSampling(runtime);

    try {
      port.postMessage({
        kind: "sw.recording-status",
        active: true,
        sid: runtime.sid,
        mode: runtime.mode,
        sampling,
        capturePolicy: runtime.config.capturePolicy,
        injectedBridgeNonce: runtime.injectedBridgeNonce,
        pointer: toStatusPointer(runtime),
        ...toScriptScanStatus(runtime)
      });
    } catch (error) {
      logPortSendFailure(deps.shouldLogPortDebug, "sw.recording-status", error, {
        tabId,
        sid: runtime.sid,
        mode: runtime.mode
      });
    }
  }

  function handleOffscreenRuntimeMessage(rawMessage: unknown, port: PortLike): boolean {
    if (port.name !== PORT_NAMES.offscreen) {
      return false;
    }

    const message = deps.offscreenClient.receive(rawMessage);

    if (message) {
      handleOffscreenEvent(message);
    }

    // Nothing on the offscreen port is meant for the inbound router.
    return true;
  }

  function handleOffscreenEvent(message: OffscreenEventMessage): void {
    switch (message.kind) {
      case "offscreen.ready":
        notifyOffscreenPipelineStatus();
        return;
      case "offscreen.keepalive":
        return;
      case "offscreen.screen-recording-chunk":
        deps.screenRecording.handleOffscreenScreenRecordingChunk(message);
        return;
      case "offscreen.screen-recording-ended":
        void deps.screenRecording.handleOffscreenScreenRecordingEnded(message).catch((error) => {
          console.warn("[WebBlackbox] failed to finalize screen recording", error);
        });
        return;
      case "offscreen.screen-recording-error":
        deps.screenRecording.handleOffscreenScreenRecordingError(message);
        return;
    }
  }

  function notifyOffscreenPipelineStatus(): void {
    const port = portRegistry.getOffscreenPort();

    if (!port) {
      return;
    }

    try {
      const message: SwPipelineStatusMessage = {
        kind: "sw.pipeline-status",
        activeSessions: sessionRegistry.tabCount(),
        sessions: [...sessionRegistry.tabRuntimes()].map((runtime) => ({
          sid: runtime.sid,
          tabId: runtime.tabId,
          mode: runtime.mode,
          startedAt: runtime.startedAt,
          active: true,
          eventCount: runtime.capturedEventCount,
          errorCount: runtime.capturedErrorCount,
          budgetAlertCount: runtime.budgetAlertCount,
          sizeBytes: runtime.capturedSizeBytes,
          tags: [...runtime.tags],
          note: runtime.note
        })),
        updatedAt: Date.now()
      };
      deps.offscreenClient.post(port, message);
    } catch (error) {
      portRegistry.dropPort(port);
      logPortSendFailure(deps.shouldLogPortDebug, "sw.pipeline-status", error, {
        activeSessions: sessionRegistry.tabCount()
      });
    }
  }

  async function relayMarkerCommand(): Promise<void> {
    const activeTabs = (await deps.tabs?.query?.({ active: true, currentWindow: true })) ?? [];
    const tabId = activeTabs[0]?.id;

    if (typeof tabId !== "number") {
      return;
    }

    await deps.tabs?.sendMessage(tabId, { kind: "sw.marker-command" }).catch((error) => {
      console.warn("[WebBlackbox] failed to relay the marker command", { tabId, error });
    });
  }

  return {
    handlePortConnect,
    handleRuntimeMessage,
    relayMarkerCommand,
    notifyOffscreenPipelineStatus
  };
}

function resolveFullModeVisualCapture(
  message: ExtensionInboundMessage
): FullModeVisualCapture | undefined {
  if (message.kind !== "ui.start") {
    return undefined;
  }

  // Kept for a Lite request too: when the profile needs the Full engine the start runs in Full,
  // and an explicit choice (e.g. "none") must hold there. A Lite session ignores it.
  return isFullModeVisualCapture(message.visualCapture) ? message.visualCapture : undefined;
}

function isFullModeVisualCapture(value: unknown): value is FullModeVisualCapture {
  return value === "screenshots" || value === "recording" || value === "both" || value === "none";
}

function parseInboundMessage(message: unknown): ExtensionInboundMessage | null {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }

  const kind = (message as { kind?: unknown }).kind;

  if (typeof kind !== "string") {
    return null;
  }

  return message as ExtensionInboundMessage;
}

function normalizeContentFrameId(value: unknown): string | undefined {
  const candidate = asFiniteNumber(value);

  if (candidate === null) {
    return undefined;
  }

  const frameId = Math.max(0, Math.floor(candidate));

  if (frameId <= 0) {
    return undefined;
  }

  return `content-frame-${frameId}`;
}

function logInboundMessageFailure(
  kind: string,
  error: unknown,
  port?: PortLike,
  context: Record<string, unknown> = {}
): void {
  console.warn("[WebBlackbox] inbound message failed", {
    kind,
    port: port?.name,
    tabId: context.tabId ?? port?.sender?.tab?.id,
    frameId: context.frameId ?? port?.sender?.frameId,
    error: error instanceof Error ? error.message : String(error)
  });
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
