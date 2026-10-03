import type { CaptureMode, ExportPolicy, FreezeReason } from "@webblackbox/protocol";

import { getChromeApi } from "../shared/chrome-api.js";
import { loadExportPolicyPrefs, toExportPolicy } from "../shared/export-policy-prefs.js";
import { createExtensionI18n, loadExtensionLocale } from "../shared/i18n.js";
import {
  PORT_NAMES,
  type ExportPrivacyWarning,
  type ExtensionInboundMessage,
  type ExtensionOutboundMessage,
  type FullModeVisualCapture,
  type ProfilePreviewResponse,
  type SessionListItem
} from "../shared/messages.js";
import { openChoiceDialog, openPassphraseDialog } from "../shared/ui/dialogs.js";
import { el } from "../shared/ui/dom.js";
import { preserveFocus } from "../shared/ui/focus.js";
import {
  createProfilePickerSection,
  loadProfileChoice,
  PROFILE_CHOICE_AUTO,
  saveProfileChoice,
  toStartProfileId
} from "./profile-picker.js";
import {
  createLastSessionPanel,
  createPopupHeader,
  createPrivacyWarning,
  createRecordingPanel,
  createStartPanel,
  createStateLine,
  type BadgeKind,
  type PopupFormatters
} from "./view.js";

const chromeApi = getChromeApi();
// Resolved before the port opens, so no port message can arrive before its listener exists.
const i18n = createExtensionI18n({
  pageTitleKey: "pageTitlePopup",
  locale: await loadExtensionLocale()
});
const port = chromeApi?.runtime?.connect({ name: PORT_NAMES.popup });
const extensionVersion = chromeApi?.runtime?.getManifest?.().version ?? "dev";
const { t, formatMode, formatFreezeReason } = i18n;
const format: PopupFormatters = {
  t,
  formatMode,
  formatRelativeTime: i18n.formatRelativeTime,
  formatDuration: i18n.formatDuration,
  formatByteSize: i18n.formatByteSize,
  formatNumber: i18n.formatNumber
};

const root = document.getElementById("popup-root");
const POPUP_FULL_VISUAL_CAPTURE_STORAGE_KEY = "webblackbox.popup.full-visual-capture";
const START_PENDING_TIMEOUT_MS = 45_000;
const EXPORT_ACK_TIMEOUT_MS = 120_000;
const RECENT_FREEZE_WINDOW_MS = 10 * 60 * 1000;
const MARKER_COMMAND = { kind: "sw.marker-command" } as const;

const state: {
  tabId: number | null;
  sessions: SessionListItem[];
  fullModeVisualCapture: FullModeVisualCapture;
  profileChoice: string;
  profilePreview?: ProfilePreviewResponse;
  /** Engine picked in the popup; unset = the selected profile's recommendation. */
  engineOverride?: CaptureMode;
  pendingStart?: { tabId: number; mode: CaptureMode; requestedAt: number };
  pendingExportSid?: string;
  exportPrivacyWarning?: ExportPrivacyWarning;
  statusText?: string;
  statusIsError?: boolean;
  lastPrivacyAlertKey?: string;
  lastFreeze?: { sid: string; reason: FreezeReason; at: number };
} = {
  tabId: null,
  sessions: [],
  fullModeVisualCapture: "screenshots",
  profileChoice: PROFILE_CHOICE_AUTO
};

let pendingStartTimeout: ReturnType<typeof setTimeout> | null = null;
/** A dialog flow (Start, Export) is in progress; a second click must not open another one. */
let dialogFlowActive = false;
/**
 * Lives outside the re-rendered card: a live region inserted already filled is not announced,
 * so status changes are written into this one persistent node.
 */
const liveRegion = el("p", {
  className: "wb-sr-only",
  attrs: { role: "status", "aria-live": "polite", "data-popup-live": "" }
});

if (root) {
  bootstrap(root).catch((error) => {
    renderError(root, error);
  });
}

async function bootstrap(container: HTMLElement): Promise<void> {
  state.tabId = await getActiveTabId();
  state.fullModeVisualCapture = loadPopupFullVisualCapture();
  state.profileChoice = loadProfileChoice();

  container.after(liveRegion);
  port?.onMessage.addListener((message) => {
    applyMessage(message as ExtensionOutboundMessage);
    render(container);
  });
  port?.onDisconnect?.addListener(() => {
    portDisconnected = true;
    setStatus(t("popupDisconnected"), true);
    render(container);
  });
  postUiMessage({ kind: "ui.request-session-list" });
  requestProfilePreview();

  render(container);
}

/** The service worker answers on the popup port with `sw.profile-preview`. */
function requestProfilePreview(): void {
  postUiMessage({
    kind: "ui.resolve-profile",
    ...(typeof state.tabId === "number" ? { tabId: state.tabId } : {}),
    profileId: state.profileChoice
  });
}

/** A runtime response with `ok: false`, kept whole so callers can read extra flags. */
class UiMessageRejectedError extends Error {
  public constructor(
    public readonly response: { ok: false; error: string; privacyBlocked?: boolean }
  ) {
    super(response.error);
  }
}

let portDisconnected = false;

/** Posts on the popup port; false when the service worker cannot be reached. */
function postUiMessage(message: ExtensionInboundMessage): boolean {
  if (!port || portDisconnected) {
    return false;
  }

  try {
    port.postMessage(message);
    return true;
  } catch {
    portDisconnected = true;
    return false;
  }
}

async function sendUiMessage(message: ExtensionInboundMessage): Promise<unknown> {
  if (typeof chromeApi?.runtime?.sendMessage === "function") {
    const response = await chromeApi.runtime.sendMessage(message);

    if (isRejectedRuntimeResponse(response)) {
      throw new UiMessageRejectedError(response);
    }

    return response;
  }

  postUiMessage(message);
  return undefined;
}

async function withExportAckTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(t("popupExportTimedOut")));
        }, EXPORT_ACK_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

type PopupSessions = {
  /** Recording session to show (the current tab's first). */
  activeSession?: SessionListItem;
  recordingHere: boolean;
  /** Stopped session the Export button exports (the current tab's latest first). */
  exportSession?: SessionListItem;
};

function selectSessions(): PopupSessions {
  const byRecency = [...state.sessions].sort((left, right) => right.startedAt - left.startedAt);
  const onTab = byRecency.filter((item) => item.tabId === state.tabId);
  const activeSession = onTab.find((item) => item.active) ?? byRecency.find((item) => item.active);
  const recordingHere = Boolean(activeSession && activeSession.tabId === state.tabId);
  const exportSession = recordingHere
    ? undefined
    : (onTab.find((item) => !item.active) ?? byRecency.find((item) => !item.active));

  return { activeSession, recordingHere, exportSession };
}

/** The engine Start uses: the popup's pick, else the profile's recommendation, else Lite. */
function resolveEngine(): CaptureMode {
  return state.engineOverride ?? state.profilePreview?.selection?.base ?? "lite";
}

function render(container: HTMLElement): void {
  const now = Date.now();
  const pendingStart = getFreshPendingStart(now);
  const { activeSession, recordingHere, exportSession } = selectSessions();
  const recentFreeze =
    state.lastFreeze && now - state.lastFreeze.at <= RECENT_FREEZE_WINDOW_MS
      ? state.lastFreeze
      : null;
  const badge: BadgeKind = recentFreeze ? "alert" : activeSession ? "rec" : "idle";
  const section = el("section", { className: "card wb-popup" }, [
    createPopupHeader({ t, version: extensionVersion, badge, tabId: state.tabId }),
    createStateLine(
      describeStatus(activeSession, exportSession),
      recentFreeze
        ? `${t("popupLabelIncident")}: ${t("popupRecentFreeze", {
            reason: formatFreezeReason(recentFreeze.reason),
            timeAgo: format.formatRelativeTime(recentFreeze.at, now)
          })}`
        : null
    )
  ]);

  if (activeSession) {
    section.append(
      createRecordingPanel({ session: activeSession, onCurrentTab: recordingHere, now, format })
    );
  }

  if (!recordingHere) {
    section.append(createStartArea(Boolean(pendingStart && pendingStart.tabId === state.tabId)));
  }

  if (exportSession) {
    const prefs = loadExportPolicyPrefs();
    section.append(
      createLastSessionPanel({
        session: exportSession,
        now,
        format,
        exporting: Boolean(state.pendingExportSid),
        limitsText: t("popupArchiveLimits", {
          size: prefs.maxArchiveMb,
          minutes: prefs.recentMinutes
        })
      })
    );
  }

  section.append(
    el("p", {
      className: state.statusIsError
        ? "wb-popup__status wb-popup__status--error"
        : "wb-popup__status",
      text: state.statusText ?? ""
    })
  );

  if (state.exportPrivacyWarning) {
    section.append(
      createPrivacyWarning(
        t("popupExportPrivacyWarningTitle"),
        formatExportPrivacyWarning(state.exportPrivacyWarning)
      )
    );
  }

  section.append(
    el("p", {
      className: "wb-popup__footer",
      text: `v${extensionVersion} · ${t("popupMarkerHint")}`
    })
  );

  preserveFocus(container, () => container.replaceChildren(section));
  bindActions(container, activeSession, exportSession);
  announce(state.statusText ?? "");
}

function announce(text: string): void {
  if (liveRegion.textContent !== text) {
    liveRegion.textContent = text;
  }
}

function describeStatus(
  activeSession: SessionListItem | undefined,
  exportSession: SessionListItem | undefined
): string {
  if (activeSession) {
    return activeSession.tabId === state.tabId
      ? t("popupStatusRecordingCurrent", { mode: formatMode(activeSession.mode) })
      : t("popupStatusRecordingOtherTab", {
          mode: formatMode(activeSession.mode),
          tabId: activeSession.tabId
        });
  }

  if (!exportSession) {
    return t("popupStatusIdle");
  }

  return exportSession.tabId === state.tabId
    ? t("popupStatusIdleLastCurrent", { mode: formatMode(exportSession.mode) })
    : t("popupStatusIdleLastOtherTab", {
        mode: formatMode(exportSession.mode),
        tabId: exportSession.tabId
      });
}

function createStartArea(pending: boolean): HTMLElement {
  return createStartPanel({
    t,
    profilePicker: createProfilePickerSection({
      preview: state.profilePreview,
      choice: state.profileChoice,
      disabled: pending,
      t,
      formatMode
    }),
    engine: resolveEngine(),
    visualCapture: state.fullModeVisualCapture,
    pinnedVisual: state.profilePreview?.selection?.visual,
    pending
  });
}

function bindActions(
  container: HTMLElement,
  activeSession?: SessionListItem,
  exportSession?: SessionListItem
): void {
  const on = (action: string, handler: () => void | Promise<void>): void => {
    const fail = (error: unknown): void => {
      setStatus(t("popupActionFailed", { error: errorMessage(error) }), true);
      render(container);
    };

    container.querySelector(`[data-action='${action}']`)?.addEventListener("click", () => {
      try {
        void Promise.resolve(handler()).catch(fail);
      } catch (error) {
        fail(error);
      }
    });
  };

  on("start", () => runDialogFlow(() => startFromPopup(container)));
  on("stop", () => {
    if (activeSession && !postUiMessage({ kind: "ui.stop", tabId: activeSession.tabId })) {
      setStatus(t("popupDisconnected"), true);
      render(container);
    }
  });
  on("marker", () => (activeSession ? addMarker(container, activeSession) : undefined));
  on("export", () =>
    exportSession ? runDialogFlow(() => exportWithDialog(container, exportSession)) : undefined
  );
  on("open-sessions", () => openExtensionPage("sessions.html"));
  on("open-options", () => openExtensionPage("options.html"));

  container
    .querySelector<HTMLSelectElement>("[data-profile-select]")
    ?.addEventListener("change", (event) => {
      const select = event.currentTarget as HTMLSelectElement;
      state.profileChoice = select.value || PROFILE_CHOICE_AUTO;
      state.engineOverride = undefined;
      saveProfileChoice(state.profileChoice);
      requestProfilePreview();
    });

  container.querySelectorAll<HTMLInputElement>("input[name='capture-mode']").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked && (input.value === "lite" || input.value === "full")) {
        state.engineOverride = input.value;
        render(container);
      }
    });
  });

  container
    .querySelectorAll<HTMLInputElement>("input[name='full-visual-capture']")
    .forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked && isFullModeVisualCapture(input.value)) {
          state.fullModeVisualCapture = input.value;
          savePopupFullVisualCapture(state.fullModeVisualCapture);
        }
      });
    });
}

/** Runs one dialog flow at a time; clicks while one is open (or awaiting the tab) are ignored. */
async function runDialogFlow(flow: () => Promise<void>): Promise<void> {
  if (dialogFlowActive) {
    return;
  }

  dialogFlowActive = true;

  try {
    await flow();
  } finally {
    dialogFlowActive = false;
  }
}

async function startFromPopup(container: HTMLElement): Promise<void> {
  const resolvedTabId = await getActiveTabId();
  const tabId = typeof resolvedTabId === "number" ? resolvedTabId : state.tabId;

  if (typeof tabId !== "number" || selectSessions().recordingHere) {
    return;
  }

  state.tabId = tabId;

  if (resolveEngine() === "full") {
    await startRecordingFromPopup(container, tabId, "full", {
      visualCapture: state.fullModeVisualCapture
    });
    return;
  }

  const startAction = await openChoiceDialog<"reload" | "direct">({
    title: t("popupLiteReloadTitle"),
    body: t("popupLiteReloadBody"),
    cancelLabel: t("popupCancel"),
    cancelAction: "start-lite-cancel",
    choices: [
      {
        value: "direct",
        label: t("popupLiteStartWithoutReload"),
        action: "start-lite-direct",
        variant: "surface"
      },
      {
        value: "reload",
        label: t("popupLiteReloadStart"),
        action: "start-lite-reload",
        variant: "brand",
        primary: true
      }
    ]
  });

  if (startAction !== null) {
    await startRecordingFromPopup(container, tabId, "lite", {
      reloadPage: startAction === "reload"
    });
  }
}

async function exportWithDialog(container: HTMLElement, session: SessionListItem): Promise<void> {
  const passphrase = await openPassphraseDialog({
    title: t("popupExportPassphraseTitle"),
    body: t("popupExportPassphraseBody"),
    label: t("popupPassphraseLabel"),
    submitLabel: t("popupExport"),
    cancelLabel: t("popupCancel")
  });

  if (passphrase !== null) {
    await exportSessionFromPopup(container, session.sid, passphrase, buildExportPolicy(session));
  }
}

/** Same path as the keyboard shortcut: the tab's content script emits the marker. */
async function addMarker(container: HTMLElement, session: SessionListItem): Promise<void> {
  try {
    if (typeof chromeApi?.tabs?.sendMessage !== "function") {
      throw new Error(t("unknownError"));
    }

    await chromeApi.tabs.sendMessage(session.tabId, MARKER_COMMAND);
    setStatus(t("popupMarkerAdded"), false);
  } catch (error) {
    setStatus(t("popupMarkerFailed", { error: errorMessage(error) }), true);
  }

  render(container);
}

function setStatus(text: string, isError: boolean): void {
  state.statusText = text;
  state.statusIsError = isError;
}

async function openExtensionPage(path: string): Promise<void> {
  const url = chromeApi?.runtime?.getURL(path);

  if (!url || typeof chromeApi?.tabs?.create !== "function") {
    return;
  }

  await chromeApi.tabs.create({ url, active: true });
  window.close();
}

async function startRecordingFromPopup(
  container: HTMLElement,
  tabId: number,
  mode: CaptureMode,
  options: { reloadPage?: boolean; visualCapture?: FullModeVisualCapture } = {}
): Promise<void> {
  state.statusText = undefined;
  state.statusIsError = undefined;
  setPendingStart(container, tabId, mode);
  const profileId = toStartProfileId(state.profileChoice);

  try {
    await sendUiMessage({
      kind: "ui.start",
      tabId,
      mode,
      ...(profileId ? { profileId } : {}),
      ...(options.reloadPage ? { reloadPage: true } : {}),
      ...(mode === "full" && options.visualCapture ? { visualCapture: options.visualCapture } : {})
    });
  } catch (error) {
    clearPendingStart();
    setStatus(t("popupStartFailed", { error: errorMessage(error) }), true);
    render(container);
  }
}

function setPendingStart(container: HTMLElement, tabId: number, mode: CaptureMode): void {
  clearPendingStart();
  state.pendingStart = { tabId, mode, requestedAt: Date.now() };
  pendingStartTimeout = setTimeout(() => {
    if (!state.pendingStart) {
      return;
    }

    clearPendingStart();
    render(container);
  }, START_PENDING_TIMEOUT_MS);
  render(container);
}

function clearPendingStart(): void {
  state.pendingStart = undefined;

  if (pendingStartTimeout !== null) {
    clearTimeout(pendingStartTimeout);
    pendingStartTimeout = null;
  }
}

function getFreshPendingStart(now: number): typeof state.pendingStart {
  if (!state.pendingStart) {
    return undefined;
  }

  if (now - state.pendingStart.requestedAt > START_PENDING_TIMEOUT_MS) {
    clearPendingStart();
    return undefined;
  }

  return state.pendingStart;
}

function clearPendingStartIfActivated(sessions: SessionListItem[]): void {
  const pendingStart = state.pendingStart;

  if (
    pendingStart &&
    sessions.some(
      (session) =>
        session.active && session.tabId === pendingStart.tabId && session.mode === pendingStart.mode
    )
  ) {
    clearPendingStart();
  }
}

function isRejectedRuntimeResponse(value: unknown): value is { ok: false; error: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

async function exportSessionFromPopup(
  container: HTMLElement,
  sid: string,
  passphrase: string,
  policy: ExportPolicy,
  options: { acknowledgePrivacyFindings?: boolean } = {}
): Promise<void> {
  state.pendingExportSid = sid;
  state.exportPrivacyWarning = undefined;
  state.lastPrivacyAlertKey = undefined;
  setStatus(t("popupExporting"), false);
  render(container);

  try {
    const response = await withExportAckTimeout(
      sendUiMessage({
        kind: "ui.export",
        sid,
        ...(passphrase.length > 0 ? { passphrase } : {}),
        saveAs: false,
        policy,
        ...(options.acknowledgePrivacyFindings ? { acknowledgePrivacyFindings: true } : {})
      })
    );
    state.pendingExportSid = undefined;

    if (isSuccessfulExportResponse(response)) {
      setStatus(t("popupExported", { name: response.fileName ?? sid }), false);
      applyExportPrivacyWarning(response.privacyWarning);
    }

    render(container);
  } catch (error) {
    state.pendingExportSid = undefined;

    if (
      error instanceof UiMessageRejectedError &&
      error.response.privacyBlocked === true &&
      !options.acknowledgePrivacyFindings &&
      window.confirm(t("popupPrivacyBlockedConfirm", { error: error.message }))
    ) {
      await exportSessionFromPopup(container, sid, passphrase, policy, {
        acknowledgePrivacyFindings: true
      });
      return;
    }

    setStatus(t("popupExportFailed", { error: errorMessage(error) }), true);
    render(container);
  }
}

function buildExportPolicy(session: SessionListItem): ExportPolicy {
  return toExportPolicy(
    loadExportPolicyPrefs(),
    session.mode === "full" ? state.fullModeVisualCapture : "none"
  );
}

function isSuccessfulExportResponse(value: unknown): value is {
  ok: true;
  fileName?: string;
  privacyWarning?: ExportPrivacyWarning;
} {
  return value !== null && typeof value === "object" && (value as { ok?: unknown }).ok === true;
}

function applyExportPrivacyWarning(warning: ExportPrivacyWarning | undefined): void {
  if (!warning || !loadExportPolicyPrefs().alertSensitiveFindings) {
    state.exportPrivacyWarning = undefined;
    return;
  }

  state.exportPrivacyWarning = warning;
  const alertKey = `${warning.findingCount}:${warning.summary}`;

  if (state.lastPrivacyAlertKey === alertKey) {
    return;
  }

  state.lastPrivacyAlertKey = alertKey;
  window.alert(formatExportPrivacyWarning(warning));
}

function formatExportPrivacyWarning(warning: ExportPrivacyWarning): string {
  return t("popupExportPrivacyWarningAlert", {
    count: warning.findingCount,
    summary: warning.summary || t("unknownError")
  });
}

function applyMessage(message: ExtensionOutboundMessage): void {
  switch (message.kind) {
    case "sw.session-list":
      state.sessions = message.sessions;
      clearPendingStartIfActivated(message.sessions);
      return;
    case "sw.recording-status":
      if (message.active && state.pendingStart && message.mode === state.pendingStart.mode) {
        clearPendingStart();
      }
      return;
    case "sw.export-status":
      if (state.pendingExportSid === message.sid) {
        state.pendingExportSid = undefined;
      }

      state.exportPrivacyWarning = undefined;
      setStatus(
        message.ok
          ? t("popupExported", { name: message.fileName ?? message.sid })
          : t("popupExportFailed", { error: message.error ?? t("unknownError") }),
        !message.ok
      );

      if (message.ok) {
        applyExportPrivacyWarning(message.privacyWarning);
      }
      return;
    case "sw.profile-preview":
      state.profilePreview = message;
      return;
    case "sw.freeze":
      state.lastFreeze = { sid: message.sid, reason: message.reason, at: Date.now() };
      return;
    default:
      return;
  }
}

async function getActiveTabId(): Promise<number | null> {
  const focusedTabs =
    (await chromeApi?.tabs?.query?.({ active: true, lastFocusedWindow: true })) ?? [];
  const focusedActiveRecordable = focusedTabs.find(
    (tab) => typeof tab.id === "number" && isRecordableTabUrl(tab.url)
  );

  if (focusedActiveRecordable && typeof focusedActiveRecordable.id === "number") {
    return focusedActiveRecordable.id;
  }

  const allTabs = (await chromeApi?.tabs?.query?.({})) ?? [];
  const activeRecordable = allTabs.find(
    (tab) => tab.active && typeof tab.id === "number" && isRecordableTabUrl(tab.url)
  );

  if (activeRecordable && typeof activeRecordable.id === "number") {
    return activeRecordable.id;
  }

  const recordableByRecency = allTabs
    .filter((tab) => typeof tab.id === "number" && isRecordableTabUrl(tab.url))
    .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0));

  if (typeof recordableByRecency[0]?.id === "number") {
    return recordableByRecency[0].id;
  }

  const activeAny =
    focusedTabs.find((tab) => tab.active && typeof tab.id === "number") ??
    allTabs.find((tab) => tab.active && typeof tab.id === "number");
  return activeAny && typeof activeAny.id === "number" ? activeAny.id : null;
}

function isRecordableTabUrl(url: string | undefined): boolean {
  return (
    typeof url === "string" &&
    url.length > 0 &&
    !url.startsWith("chrome-extension://") &&
    !url.startsWith("chrome://") &&
    url !== "about:blank"
  );
}

function loadPopupFullVisualCapture(): FullModeVisualCapture {
  try {
    const raw = globalThis.localStorage?.getItem(POPUP_FULL_VISUAL_CAPTURE_STORAGE_KEY);
    return raw && isFullModeVisualCapture(raw) ? raw : "screenshots";
  } catch {
    return "screenshots";
  }
}

function savePopupFullVisualCapture(value: FullModeVisualCapture): void {
  try {
    globalThis.localStorage?.setItem(POPUP_FULL_VISUAL_CAPTURE_STORAGE_KEY, value);
  } catch {
    // ignore storage write failures
  }
}

function isFullModeVisualCapture(value: string): value is FullModeVisualCapture {
  return value === "screenshots" || value === "recording" || value === "both" || value === "none";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderError(container: HTMLElement, error: unknown): void {
  container.replaceChildren(
    el("section", { className: "card wb-popup" }, [
      el("h1", { className: "wb-popup__title", text: "WebBlackbox" }),
      el("p", { className: "wb-popup__status wb-popup__status--error", text: String(error) })
    ])
  );
}
