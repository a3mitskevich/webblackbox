import { getChromeApi } from "../shared/chrome-api.js";
import { loadExportPolicyPrefs, toExportPolicy } from "../shared/export-policy-prefs.js";
import { createExtensionI18n } from "../shared/i18n.js";
import {
  PORT_NAMES,
  type ExportPrivacyWarning,
  type ExtensionInboundMessage,
  type ExtensionOutboundMessage,
  type SessionListItem
} from "../shared/messages.js";
import { openConfirmDialog, openPassphraseDialog } from "../shared/ui/dialogs.js";
import { el } from "../shared/ui/dom.js";
import { preserveFocus } from "../shared/ui/focus.js";
import { icon } from "../shared/ui/icons.js";
import {
  EMPTY_FILTERS,
  filterSessions,
  listProfileNames,
  normalizeNoteInput,
  parseTagInput,
  shortenSessionId,
  type SessionFilters,
  type SessionStatusFilter
} from "./model.js";
import {
  createBulkBar,
  createSessionsTable,
  createToolbar,
  fillProfileOptions,
  type SessionFormatters
} from "./table.js";

/** Hosted Player; archives are opened there locally and never uploaded. */
const PLAYER_URL = "https://webllm.github.io/webblackbox/";

const chromeApi = getChromeApi();
const port = chromeApi?.runtime?.connect({ name: PORT_NAMES.sessions });
const i18n = createExtensionI18n({ pageTitleKey: "pageTitleSessions" });
const { locale, t } = i18n;
const format: SessionFormatters = {
  t,
  formatMode: i18n.formatMode,
  formatRelativeTime: i18n.formatRelativeTime,
  formatDuration: i18n.formatDuration,
  formatByteSize: i18n.formatByteSize,
  formatAbsoluteTime: (timestamp) => new Date(timestamp).toLocaleString(locale)
};
const root = document.getElementById("sessions-root");

type PendingExport = { passphrase: string; acknowledged: boolean; openPlayer: boolean };

type Page = {
  root: HTMLElement;
  count: HTMLElement;
  profileFilter: HTMLSelectElement;
  bulk: HTMLElement;
  list: HTMLElement;
};

const state: {
  sessions: SessionListItem[];
  filters: SessionFilters;
  selected: Set<string>;
  expandedSid?: string;
} = {
  sessions: [],
  filters: { ...EMPTY_FILTERS },
  selected: new Set()
};
/** Exports started on this page, by sid, so a blocked one can be confirmed and re-sent. */
const pendingExports = new Map<string, PendingExport>();

if (root) {
  const page = createPage();
  root.replaceChildren(page.root);
  renderList(page);
  bindPage(page);

  port?.onMessage.addListener((message) => {
    const typed = message as ExtensionOutboundMessage;

    if (typed.kind === "sw.session-list") {
      state.sessions = typed.sessions;
      const known = new Set(typed.sessions.map((session) => session.sid));
      state.selected = new Set([...state.selected].filter((sid) => known.has(sid)));
      renderList(page);
      return;
    }

    if (typed.kind === "sw.export-status") {
      handleExportStatus(typed);
    }
  });
}

function createTopBar(count: HTMLElement): HTMLElement {
  return el("header", { className: "wb-page-topbar" }, [
    el("div", { className: "wb-brand-lockup" }, [
      el("img", {
        className: "wb-brand-lockup__icon",
        attrs: { src: "./icon/32.png", alt: "", width: "28", height: "28" }
      }),
      el("div", { className: "wb-brand-lockup__copy" }, [
        el("p", { className: "wb-brand-lockup__eyebrow", text: t("brandEyebrowChromeExtension") }),
        el("h1", {
          className: "wb-brand-lockup__title wb-sessions-title",
          text: t("sessionsTitle")
        })
      ])
    ]),
    el("div", { className: "wb-page-topbar__aside" }, [
      count,
      el(
        "a",
        { className: "wb-btn wb-btn--ghost wb-btn--small", attrs: { href: "./options.html" } },
        [icon("settings"), t("popupOptions")]
      )
    ])
  ]);
}

function createPage(): Page {
  const count = el("span", { className: "wb-sessions__count", dataset: { sessionsCount: "" } });
  const toolbar = createToolbar({ t, filters: state.filters, profiles: [] });
  const bulk = el("div");
  const list = el("div", { className: "wb-sessions__list" });

  return {
    root: el("div", { className: "wb-sessions" }, [
      createTopBar(count),
      el("div", { className: "wb-sessions__body" }, [
        el("p", { className: "wb-sessions__subtitle", text: t("sessionsSubtitle") }),
        el("div", { className: "wb-sessions__controls" }, [toolbar, bulk]),
        list
      ])
    ]),
    count,
    profileFilter:
      toolbar.querySelector<HTMLSelectElement>("[data-profile-filter]") ?? el("select"),
    bulk,
    list
  };
}

function visibleSessions(): SessionListItem[] {
  return filterSessions(state.sessions, state.filters);
}

/** Bulk actions only ever act on rows the user can see. */
function selectedVisibleSessions(): SessionListItem[] {
  return visibleSessions().filter((session) => state.selected.has(session.sid));
}

type AnnotationDraft = { sid: string; tags: string; note: string };

function findAnnotationForm(list: HTMLElement, sid: string): HTMLFormElement | undefined {
  return Array.from(list.querySelectorAll<HTMLFormElement>("form[data-annotate]")).find(
    (form) => form.dataset.annotate === sid
  );
}

/** Typed tags/note of the open detail panel, so a list push does not wipe them. */
function readAnnotationDraft(list: HTMLElement, sid: string): AnnotationDraft | undefined {
  const form = findAnnotationForm(list, sid);

  if (!form) {
    return undefined;
  }

  return {
    sid,
    tags: form.querySelector<HTMLInputElement>("[data-annotate-tags]")?.value ?? "",
    note: form.querySelector<HTMLTextAreaElement>("[data-annotate-note]")?.value ?? ""
  };
}

function restoreAnnotationDraft(list: HTMLElement, draft: AnnotationDraft | undefined): void {
  const form = draft ? findAnnotationForm(list, draft.sid) : undefined;

  if (!draft || !form) {
    return;
  }

  const tags = form.querySelector<HTMLInputElement>("[data-annotate-tags]");
  const note = form.querySelector<HTMLTextAreaElement>("[data-annotate-note]");

  if (tags) {
    tags.value = draft.tags;
  }

  if (note) {
    note.value = draft.note;
  }
}

function renderList(page: Page): void {
  const draft = state.expandedSid ? readAnnotationDraft(page.list, state.expandedSid) : undefined;

  // The draft goes back before focus does, so the restored caret lands in the typed text.
  preserveFocus(page.root, () => {
    renderListContent(page);
    restoreAnnotationDraft(page.list, draft);
  });
}

function renderListContent(page: Page): void {
  const visible = visibleSessions();

  page.count.textContent = t("sessionsCountSummary", {
    total: state.sessions.length,
    active: state.sessions.filter((session) => session.active).length
  });
  fillProfileOptions(
    page.profileFilter,
    listProfileNames(state.sessions),
    state.filters.profile,
    t
  );
  page.bulk.replaceChildren(createBulkBar(t, selectedVisibleSessions().length));

  if (visible.length === 0) {
    page.list.replaceChildren(
      el("p", {
        className: "wb-empty wb-sessions-empty",
        text: state.sessions.length === 0 ? t("sessionsEmpty") : t("sessionsNoMatches")
      })
    );
    return;
  }

  page.list.replaceChildren(
    createSessionsTable({
      sessions: visible,
      selected: state.selected,
      ...(state.expandedSid ? { expandedSid: state.expandedSid } : {}),
      now: Date.now(),
      format
    })
  );
}

function onSelectionChange(page: Page, target: HTMLInputElement): boolean {
  if (target.dataset.selectAll !== undefined) {
    const visible = visibleSessions().map((session) => session.sid);
    state.selected = target.checked
      ? new Set([...state.selected, ...visible])
      : new Set([...state.selected].filter((sid) => !visible.includes(sid)));
    renderList(page);
    return true;
  }

  const sid = target.dataset.selectSid;

  if (!sid) {
    return false;
  }

  const next = new Set(state.selected);

  if (target.checked) {
    next.add(sid);
  } else {
    next.delete(sid);
  }

  state.selected = next;
  renderList(page);
  return true;
}

function bindPage(page: Page): void {
  page.root.addEventListener("input", (event) => onFilterChange(page, event.target));
  page.root.addEventListener("change", (event) => {
    const target = event.target;

    if (target instanceof HTMLInputElement && onSelectionChange(page, target)) {
      return;
    }

    onFilterChange(page, target);
  });
  page.root.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button");

    if (button) {
      void handleButton(page, button);
    }
  });
  page.root.addEventListener("submit", (event) => {
    const form = (event.target as Element | null)?.closest<HTMLFormElement>("form[data-annotate]");
    const sid = form?.dataset.annotate;

    if (!form || !sid) {
      return;
    }

    event.preventDefault();
    postUiMessage({
      kind: "ui.annotate",
      sid,
      tags: parseTagInput(
        form.querySelector<HTMLInputElement>("[data-annotate-tags]")?.value ?? ""
      ),
      note: normalizeNoteInput(
        form.querySelector<HTMLTextAreaElement>("[data-annotate-note]")?.value ?? ""
      )
    });
  });
}

function onFilterChange(page: Page, target: EventTarget | null): void {
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) {
    return;
  }

  const filters = state.filters;

  switch (target.name) {
    case "sessionSearch":
      state.filters = { ...filters, query: target.value };
      break;
    case "sessionStatus":
      state.filters = { ...filters, status: toStatusFilter(target.value) };
      break;
    case "sessionProfile":
      state.filters = { ...filters, profile: target.value };
      break;
    case "sessionErrorsOnly":
      state.filters = {
        ...filters,
        errorsOnly: target instanceof HTMLInputElement && target.checked
      };
      break;
    default:
      return;
  }

  // Rows a filter hides are deselected, so a bulk action never reaches rows out of sight.
  const visible = new Set(visibleSessions().map((session) => session.sid));
  state.selected = new Set([...state.selected].filter((sid) => visible.has(sid)));
  renderList(page);
}

function toStatusFilter(value: string): SessionStatusFilter {
  return value === "live" || value === "stopped" ? value : "all";
}

async function handleButton(page: Page, button: HTMLButtonElement): Promise<void> {
  const data = button.dataset;
  const exportSid = data.export ?? data.player;

  if (exportSid) {
    const passphrase = await askPassphrase(shortenSessionId(exportSid));

    if (passphrase !== null) {
      requestExport(exportSid, passphrase, {
        acknowledged: false,
        openPlayer: Boolean(data.player)
      });
    }

    return;
  }

  if (data.stop) {
    const tabId = Number(data.stop);

    if (Number.isFinite(tabId)) {
      postUiMessage({ kind: "ui.stop", tabId });
    }

    return;
  }

  if (data.notes) {
    state.expandedSid = state.expandedSid === data.notes ? undefined : data.notes;
    renderList(page);
    return;
  }

  if (data.delete) {
    const live = state.sessions.some((session) => session.sid === data.delete && session.active);
    const prompt = live ? "sessionsDeleteLivePrompt" : "sessionsDeletePrompt";

    if (await confirmDelete(t(prompt, { sid: data.delete }))) {
      postUiMessage({ kind: "ui.delete", sid: data.delete });
    }

    return;
  }

  if (data.bulk === "export") {
    await exportSelected();
  } else if (data.bulk === "delete") {
    await deleteSelected(page);
  }
}

async function exportSelected(): Promise<void> {
  const sids = selectedVisibleSessions().map((session) => session.sid);

  if (sids.length === 0) {
    return;
  }

  const passphrase = await askPassphrase(t("sessionsSelectedCount", { count: sids.length }));

  if (passphrase !== null) {
    sids.forEach((sid) =>
      requestExport(sid, passphrase, { acknowledged: false, openPlayer: false })
    );
  }
}

async function deleteSelected(page: Page): Promise<void> {
  const targets = selectedVisibleSessions();
  const live = targets.filter((session) => session.active).length;
  const prompt =
    live > 0
      ? t("sessionsBulkDeleteLivePrompt", { count: targets.length, live })
      : t("sessionsBulkDeletePrompt", { count: targets.length });

  if (targets.length === 0 || !(await confirmDelete(prompt))) {
    return;
  }

  const deleted = new Set(targets.map((session) => session.sid));
  deleted.forEach((sid) => postUiMessage({ kind: "ui.delete", sid }));
  state.selected = new Set([...state.selected].filter((sid) => !deleted.has(sid)));
  renderList(page);
}

function askPassphrase(detail: string): Promise<string | null> {
  return openPassphraseDialog({
    title: t("sessionsExportDialogTitle"),
    body: t("sessionsExportDialogBody"),
    label: t("popupPassphraseLabel"),
    submitLabel: t("sessionsActionExport"),
    cancelLabel: t("popupCancel"),
    detail
  });
}

function confirmDelete(body: string): Promise<boolean> {
  return openConfirmDialog({
    title: t("sessionsConfirmDeleteTitle"),
    body,
    acceptLabel: t("sessionsActionDelete"),
    cancelLabel: t("popupCancel"),
    acceptVariant: "danger"
  });
}

function handleExportStatus(
  status: Extract<ExtensionOutboundMessage, { kind: "sw.export-status" }>
): void {
  const pending = pendingExports.get(status.sid);

  if (status.ok) {
    pendingExports.delete(status.sid);

    if (status.privacyWarning && loadExportPolicyPrefs().alertSensitiveFindings) {
      window.alert(formatExportPrivacyWarning(status.privacyWarning));
    }

    if (pending?.openPlayer && typeof chromeApi?.tabs?.create === "function") {
      void chromeApi.tabs.create({ url: PLAYER_URL, active: true });
    }

    return;
  }

  // Failures of exports started elsewhere (e.g. the popup) are reported there.
  if (!pending) {
    return;
  }

  pendingExports.delete(status.sid);
  const error = status.error || t("unknownError");

  if (
    status.privacyBlocked === true &&
    !pending.acknowledged &&
    window.confirm(t("popupPrivacyBlockedConfirm", { error }))
  ) {
    requestExport(status.sid, pending.passphrase, { ...pending, acknowledged: true });
    return;
  }

  window.alert(t("popupExportFailed", { error }));
}

function requestExport(
  sid: string,
  passphrase: string,
  options: { acknowledged: boolean; openPlayer: boolean }
): void {
  pendingExports.set(sid, { passphrase, ...options });
  postUiMessage({
    kind: "ui.export",
    sid,
    ...(passphrase.length > 0 ? { passphrase } : {}),
    saveAs: false,
    // Archive limits from Options, as in the popup; screenshots stay out as before.
    policy: toExportPolicy(loadExportPolicyPrefs(), "none"),
    ...(options.acknowledged ? { acknowledgePrivacyFindings: true } : {})
  });
}

function postUiMessage(message: ExtensionInboundMessage): void {
  try {
    port?.postMessage(message);
  } catch {
    void 0;
  }
}

function formatExportPrivacyWarning(warning: ExportPrivacyWarning): string {
  return t("popupExportPrivacyWarningAlert", {
    count: warning.findingCount,
    summary: warning.summary || t("unknownError")
  });
}
