import type { CaptureMode } from "@webblackbox/protocol";

import type { ExtensionMessageKey } from "../shared/i18n.js";
import type { SessionListItem } from "../shared/messages.js";
import { el } from "../shared/ui/dom.js";
import { icon, type IconName } from "../shared/ui/icons.js";
import { describeSessionPage, shortenSessionId, type SessionFilters } from "./model.js";

/** DOM builders for the sessions page: filter toolbar, bulk bar and the sessions table. */

type Translate = (key: ExtensionMessageKey, vars?: Record<string, string | number>) => string;

export type SessionFormatters = {
  t: Translate;
  formatMode: (mode: CaptureMode) => string;
  formatRelativeTime: (timestamp: number, now: number) => string;
  formatDuration: (startedAt: number, endedAt: number) => string;
  formatByteSize: (bytes: number) => string;
  formatNumber: (value: number) => string;
  formatAbsoluteTime: (timestamp: number) => string;
};

const COLUMN_COUNT = 9;

export function createToolbar(options: {
  t: Translate;
  filters: SessionFilters;
  profiles: readonly string[];
}): HTMLElement {
  const { t, filters } = options;
  const search = el("input", {
    className: "wb-input",
    attrs: {
      type: "search",
      id: "sessions-search",
      name: "sessionSearch",
      placeholder: t("sessionsSearchPlaceholder"),
      autocomplete: "off"
    }
  });
  search.value = filters.query;
  const status = el("select", {
    className: "wb-select",
    attrs: { id: "sessions-status", name: "sessionStatus" }
  });
  const statusOptions: Array<[string, ExtensionMessageKey]> = [
    ["all", "sessionsFilterAll"],
    ["live", "sessionsFilterLive"],
    ["stopped", "sessionsFilterStopped"]
  ];
  statusOptions.forEach(([value, key]) =>
    status.append(el("option", { text: t(key), attrs: { value } }))
  );
  status.value = filters.status;
  const profile = el("select", {
    className: "wb-select",
    attrs: { id: "sessions-profile", name: "sessionProfile" },
    dataset: { profileFilter: "" }
  });
  fillProfileOptions(profile, options.profiles, filters.profile, t);
  const errorsOnly = el("input", {
    attrs: { type: "checkbox", id: "sessions-errors", name: "sessionErrorsOnly" }
  });
  errorsOnly.checked = filters.errorsOnly;

  return el(
    "div",
    {
      className: "wb-toolbar",
      attrs: { role: "search", "aria-label": t("sessionsFiltersLabel") }
    },
    [
      el("div", { className: "wb-toolbar__search" }, [
        el("label", {
          className: "wb-sr-only",
          text: t("sessionsSearchLabel"),
          attrs: { for: "sessions-search" }
        }),
        search
      ]),
      el("label", { className: "wb-toolbar__field" }, [
        el("span", { text: t("sessionsFilterStatus") }),
        status
      ]),
      el("label", { className: "wb-toolbar__field" }, [
        el("span", { text: t("sessionsFilterProfile") }),
        profile
      ]),
      el("label", { className: "wb-toolbar__check" }, [
        errorsOnly,
        el("span", { text: t("sessionsFilterErrors") })
      ])
    ]
  );
}

export function fillProfileOptions(
  select: HTMLSelectElement,
  profiles: readonly string[],
  value: string,
  t: Translate
): void {
  select.replaceChildren(
    el("option", { text: t("sessionsFilterAnyProfile"), attrs: { value: "" } }),
    ...profiles.map((name) => el("option", { text: name, attrs: { value: name } }))
  );
  select.value = profiles.includes(value) ? value : "";
}

function textButton(
  label: string,
  dataset: Record<string, string>,
  iconName: IconName,
  disabled: boolean
): HTMLButtonElement {
  const button = el(
    "button",
    { className: "wb-btn wb-btn--surface wb-btn--small", attrs: { type: "button" }, dataset },
    [icon(iconName), label]
  );
  button.disabled = disabled;
  return button;
}

export function createBulkBar(t: Translate, selectedCount: number): HTMLElement {
  const disabled = selectedCount === 0;

  return el("div", { className: "wb-bulkbar", dataset: { bulkBar: "" } }, [
    el("span", {
      className: "wb-bulkbar__count",
      text: t("sessionsSelectedCount", { count: selectedCount }),
      attrs: { "aria-live": "polite" }
    }),
    textButton(t("sessionsBulkExport"), { bulk: "export" }, "download", disabled),
    textButton(t("sessionsBulkDelete"), { bulk: "delete" }, "trash", disabled)
  ]);
}

function iconAction(
  label: string,
  dataset: Record<string, string>,
  iconName: IconName,
  options: { danger?: boolean; hint?: string } = {}
): HTMLButtonElement {
  return el(
    "button",
    {
      className: options.danger ? "wb-icon-btn wb-icon-btn--danger" : "wb-icon-btn",
      attrs: {
        type: "button",
        "aria-label": label,
        title: options.hint ?? label,
        ...(options.hint ? { "aria-description": options.hint } : {})
      },
      dataset
    },
    [icon(iconName)]
  );
}

type TableOptions = {
  sessions: readonly SessionListItem[];
  selected: ReadonlySet<string>;
  expandedSid?: string;
  now: number;
  format: SessionFormatters;
  /** A Player URL is configured; without one the rows offer no "Export and open in Player". */
  canOpenPlayer: boolean;
};

export function createSessionsTable(options: TableOptions): HTMLElement {
  const { t } = options.format;
  const selectAll = el("input", {
    attrs: { type: "checkbox", "aria-label": t("sessionsSelectAll") },
    dataset: { selectAll: "" }
  });
  const selectedCount = options.sessions.filter((session) =>
    options.selected.has(session.sid)
  ).length;
  selectAll.checked = options.sessions.length > 0 && selectedCount === options.sessions.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < options.sessions.length;
  const columns: ExtensionMessageKey[] = [
    "sessionsColumnSite",
    "sessionsColumnProfile",
    "sessionsColumnDuration",
    "sessionsColumnEvents",
    "sessionsColumnErrors",
    "sessionsColumnSize",
    "sessionsColumnDate"
  ];

  return el("table", { className: "wb-table" }, [
    el("thead", {}, [
      el("tr", {}, [
        el("th", { className: "wb-table__select", attrs: { scope: "col" } }, [selectAll]),
        ...columns.map((key) => el("th", { text: t(key), attrs: { scope: "col" } })),
        el("th", { attrs: { scope: "col" } }, [
          el("span", { className: "wb-sr-only", text: t("sessionsColumnActions") })
        ])
      ])
    ]),
    el(
      "tbody",
      {},
      options.sessions.flatMap((session) => [
        createRow(session, options),
        createAnnotationRow(session, options.expandedSid === session.sid, t)
      ])
    )
  ]);
}

function createSiteCell(session: SessionListItem, t: Translate): HTMLElement {
  const page = describeSessionPage(session, t("sessionsFallbackTab", { tabId: session.tabId }));
  const tags = session.tags ?? [];

  return el("div", { className: "wb-site" }, [
    el("div", { className: "wb-site__title" }, [
      el("strong", { text: page.primary, attrs: { title: session.url ?? page.secondary } }),
      ...(session.active
        ? [el("span", { className: "wb-badge wb-badge--live", text: t("sessionsStatusLive") })]
        : [])
    ]),
    el("span", { className: "wb-site__url mono", text: page.secondary }),
    ...(session.note
      ? [el("span", { className: "wb-site__note wb-session-card__note", text: session.note })]
      : []),
    ...(tags.length > 0
      ? [
          el(
            "span",
            { className: "wb-site__tags" },
            tags.map((tag) => el("span", { className: "wb-chip wb-chip--tag", text: `#${tag}` }))
          )
        ]
      : [])
  ]);
}

function createRow(session: SessionListItem, options: TableOptions): HTMLElement {
  const { format, now } = options;
  const { t } = format;
  const errors = session.errorCount ?? 0;
  const siteName = describeSessionPage(session, String(session.tabId)).primary;
  const select = el("input", {
    attrs: { type: "checkbox", "aria-label": t("sessionsSelectRow", { site: siteName }) },
    dataset: { selectSid: session.sid }
  });
  select.checked = options.selected.has(session.sid);
  const cell = (label: ExtensionMessageKey, children: Array<Node | string>, className = "") =>
    el("td", { className, attrs: { "data-label": t(label) } }, children);
  const notes = iconAction(t("sessionsActionNotes"), { notes: session.sid }, "marker");
  notes.setAttribute("aria-expanded", String(options.expandedSid === session.sid));

  return el(
    "tr",
    {
      className: session.active ? "wb-table__row wb-table__row--live" : "wb-table__row",
      dataset: { sessionSid: session.sid }
    },
    [
      el("td", { className: "wb-table__select" }, [select]),
      cell("sessionsColumnSite", [createSiteCell(session, t)], "wb-table__site"),
      cell("sessionsColumnProfile", [
        el("span", { text: session.profileName ?? "—" }),
        el("span", { className: "wb-table__sub", text: format.formatMode(session.mode) })
      ]),
      cell(
        "sessionsColumnDuration",
        [format.formatDuration(session.startedAt, session.stoppedAt ?? now)],
        "wb-table__num"
      ),
      cell("sessionsColumnEvents", [format.formatNumber(session.eventCount ?? 0)], "wb-table__num"),
      cell(
        "sessionsColumnErrors",
        [format.formatNumber(errors)],
        errors > 0 ? "wb-table__num wb-table__num--warn" : "wb-table__num"
      ),
      cell("sessionsColumnSize", [format.formatByteSize(session.sizeBytes ?? 0)], "wb-table__num"),
      cell("sessionsColumnDate", [
        el("span", {
          text: format.formatRelativeTime(session.startedAt, now),
          attrs: { title: format.formatAbsoluteTime(session.startedAt) }
        }),
        el("span", {
          className: "wb-table__sub mono",
          text: shortenSessionId(session.sid),
          attrs: { title: session.sid }
        })
      ]),
      el("td", { className: "wb-table__actions" }, [
        el("div", { className: "wb-row-actions" }, [
          ...(options.canOpenPlayer
            ? [
                iconAction(t("sessionsActionOpenPlayer"), { player: session.sid }, "external", {
                  hint: t("sessionsOpenPlayerHint")
                })
              ]
            : []),
          iconAction(t("sessionsActionExport"), { export: session.sid }, "download"),
          ...(session.active
            ? [iconAction(t("sessionsActionStop"), { stop: String(session.tabId) }, "stop")]
            : []),
          notes,
          iconAction(t("sessionsActionDelete"), { delete: session.sid }, "trash", { danger: true })
        ])
      ])
    ]
  );
}

/** Tags and note editor below a row; hidden until the row's notes button opens it. */
function createAnnotationRow(session: SessionListItem, open: boolean, t: Translate): HTMLElement {
  const tagsId = `tags-${session.sid}`;
  const noteId = `note-${session.sid}`;
  const tags = el("input", {
    className: "wb-input",
    attrs: { id: tagsId },
    dataset: { annotateTags: "" }
  });
  tags.value = (session.tags ?? []).join(", ");
  const note = el("textarea", {
    className: "wb-textarea",
    attrs: { id: noteId, rows: "2" },
    dataset: { annotateNote: "" }
  });
  note.value = session.note ?? "";
  const row = el("tr", { className: "wb-table__detail", dataset: { detailFor: session.sid } }, [
    el("td", { attrs: { colspan: String(COLUMN_COUNT) } }, [
      el("form", { className: "wb-annotation", dataset: { annotate: session.sid } }, [
        el("div", { className: "wb-annotation__field" }, [
          el("label", {
            className: "wb-field__label",
            text: t("sessionsTagsLabel"),
            attrs: { for: tagsId }
          }),
          tags
        ]),
        el("div", { className: "wb-annotation__field" }, [
          el("label", {
            className: "wb-field__label",
            text: t("sessionsNotesLabel"),
            attrs: { for: noteId }
          }),
          note
        ]),
        el("div", { className: "wb-annotation__actions" }, [
          el("button", {
            className: "wb-btn wb-btn--brand wb-btn--small",
            text: t("sessionsSaveContext"),
            attrs: { type: "submit" }
          })
        ])
      ])
    ])
  ]);
  row.hidden = !open;
  return row;
}
