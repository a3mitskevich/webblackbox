import type { ActionConsequence } from "@webblackbox/player-sdk";
import { useEffect, useMemo, useRef, type ReactNode } from "react";

import "../network/viewers.css";
import "./inspector.css";

import { formatOffset } from "../../../core/format.js";
import { Hint } from "../../components/hint.js";
import { Icon, type IconName } from "../../components/icon.js";
import { useController, useI18n, usePlayerState } from "../../context.js";
import { describeFeedEvent } from "../feed/feed-view.js";
import { openGenerate } from "../generate/api.js";
import { useFeatureI18n } from "../messages.js";
import { CodeView } from "../network/code-view.js";
import { CopyButton } from "../network/copy-button.js";
import { inspectSelection, type Inspection } from "./inspector-model.js";
import { describeInspection, eventTitle, shortPath } from "./inspector-text.js";
import { inspectorMessages, type InspectorTranslate } from "./messages.js";
import { placeTarget } from "./target-frame.js";

const BUTTON_KEYS = {
  left: "buttonLeft",
  middle: "buttonMiddle",
  right: "buttonRight",
  back: "buttonBack",
  forward: "buttonForward"
} as const;

const CONSEQUENCE_ICONS: Record<ActionConsequence["kind"], IconName> = {
  request: "error",
  "page-load": "nav",
  route: "nav",
  websocket: "ws",
  "console-error": "console",
  exception: "error"
};

type SectionProps = {
  title: string;
  children: ReactNode;
  testId: string;
};

function Section({ title, children, testId }: SectionProps) {
  return (
    <section className="insp-sec" data-testid={testId}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

type PartProps = { inspection: Inspection; t: InspectorTranslate };

function TargetSection({ inspection, t }: PartProps) {
  const i18n = useI18n();
  const { target, reaction } = inspection;

  if (!target) {
    return null;
  }

  const round = (value: number): string => i18n.formatNumber(Math.round(value));
  const pointer = target.pointer;
  // The stage draws the box only where it can place it (not in an iframe of unknown position).
  const outlined = placeTarget(inspection) !== null;
  const modifiers = pointer?.modifiers.length ? pointer.modifiers.join("+") : t("noModifiers");

  return (
    <Section title={t("sectionTarget")} testId="inspector-target">
      {target.selector ? (
        <div className="insp-selector">
          <code data-testid="inspector-selector">{target.selector}</code>
          <CopyButton
            label={t("copySelector")}
            getText={() => target.selector}
            testId="inspector-copy-selector"
            compact
          />
        </div>
      ) : (
        <p className="insp-note">{t(target.selectorMasked ? "selectorMasked" : "noSelector")}</p>
      )}
      <dl className="insp-kv">
        {target.element ? (
          <Field label={t("element")}>
            <code>{target.element}</code>
          </Field>
        ) : null}
        {target.rect ? (
          <Field label={t("box")}>
            <span data-testid="inspector-box">
              {t("boxValue", {
                x: round(target.rect.x),
                y: round(target.rect.y),
                width: round(target.rect.width),
                height: round(target.rect.height)
              })}
              {" · "}
              {t(outlined ? "outlinedOnVideo" : "notOutlined")}
            </span>
          </Field>
        ) : null}
        {pointer ? (
          <Field label={t("pointer")}>
            {t("pointerValue", {
              x: round(pointer.x),
              y: round(pointer.y),
              button: t(pointer.button ? BUTTON_KEYS[pointer.button] : "noButton")
            })}
            {" · "}
            {modifiers}
          </Field>
        ) : null}
        {reaction ? (
          <Field label={t("pageReacted")}>
            <span data-testid="inspector-reaction">
              {reaction.mutated && reaction.latencyMs !== null
                ? t("reactionAfter", { time: i18n.formatMilliseconds(reaction.latencyMs) })
                : t("reactionNone", { time: i18n.formatSeconds(reaction.windowMs ?? 0) })}
            </span>
          </Field>
        ) : null}
      </dl>
    </Section>
  );
}

function ConsequenceLabel({ item, t }: { item: ActionConsequence; t: InspectorTranslate }) {
  switch (item.kind) {
    case "request":
      return (
        <>
          <span className="insp-code bad">{item.status ?? <span aria-hidden="true">✕</span>}</span>
          {item.count > 1 ? (
            <span className="insp-count">
              <span aria-hidden="true">×{item.count}</span>
              <span className="visually-hidden">{t("repeatCount", { count: item.count })}</span>
            </span>
          ) : null}
          <span className="insp-method">{item.method}</span>
          <span className="insp-path" title={item.label}>
            {shortPath(item.label)}
          </span>
        </>
      );
    case "route":
      return <span className="insp-msg">{t("itemRoute", { route: item.label })}</span>;
    case "page-load":
      return <span className="insp-msg">{t("itemPageLoad", { route: item.label })}</span>;
    case "websocket":
      return <span className="insp-msg">{t("itemWebSocket", { url: shortPath(item.label) })}</span>;
    default:
      return <span className="insp-msg">{item.label}</span>;
  }
}

function CausedSection({ inspection, t }: PartProps) {
  const controller = useController();
  const i18n = useI18n();
  const archive = usePlayerState((state) => state.archive);
  const consequences = inspection.consequences;

  if (!consequences || !archive) {
    return null;
  }

  const stats = [
    { key: "requests", value: consequences.requests, label: t("statRequests"), bad: false },
    { key: "failed", value: consequences.failedRequests, label: t("statFailed"), bad: true },
    {
      key: "errors",
      value: consequences.consoleErrors + consequences.exceptions,
      label: t("statErrors"),
      bad: true
    },
    { key: "sockets", value: consequences.webSockets, label: t("statWebSockets"), bad: false }
  ];

  const open = (item: ActionConsequence): void => {
    if (item.reqId && archive.model.waterfallByReqId.has(item.reqId)) {
      controller.select({ kind: "request", id: item.reqId });
      return;
    }

    const event = archive.model.eventById.get(item.eventId);

    if (event) {
      controller.selectEvent(event);
    }
  };

  return (
    <Section
      title={t("sectionCaused", { duration: i18n.formatSeconds(consequences.durationMs) })}
      testId="inspector-caused"
    >
      <dl className="insp-stats">
        {stats.map((stat) => (
          // Label first, so a screen reader says "failed 5"; the CSS shows the number above it.
          <div key={stat.key} className="insp-stat" data-testid={`inspector-stat-${stat.key}`}>
            <dt>{stat.label}</dt>
            <dd className={stat.bad && stat.value > 0 ? "bad" : undefined}>
              {i18n.formatNumber(stat.value)}
            </dd>
          </div>
        ))}
      </dl>
      {consequences.items.length > 0 ? (
        <ul className="insp-items" data-testid="inspector-consequences">
          {consequences.items.map((item) => (
            <li key={`${item.kind}-${item.eventId}`}>
              <button
                type="button"
                className={item.failed ? "insp-item bad" : "insp-item"}
                onClick={() => open(item)}
                data-testid="inspector-consequence"
              >
                <span className="insp-off">+{i18n.formatSeconds(item.offsetMs)}</span>
                <Icon name={CONSEQUENCE_ICONS[item.kind]} />
                {item.failed ? <span className="visually-hidden">{t("failedItem")}</span> : null}
                <ConsequenceLabel item={item} t={t} />
              </button>
            </li>
          ))}
          {consequences.hiddenItems > 0 ? (
            <li className="insp-more">
              {t("moreItems", { count: i18n.formatNumber(consequences.hiddenItems) })}
            </li>
          ) : null}
        </ul>
      ) : (
        <p className="insp-note">{t("nothingNotable")}</p>
      )}
    </Section>
  );
}

function ReproduceSection({ inspection, t }: PartProps) {
  const controller = useController();
  const locale = usePlayerState((state) => state.locale);
  const minMono = usePlayerState((state) => state.archive?.model.minMono ?? 0);
  const step = inspection.playwrightStep.join("\n");
  const range = inspection.playwrightRange;

  if (!inspection.isTrigger && !step) {
    return null;
  }

  return (
    <Section title={t("sectionReproduce")} testId="inspector-reproduce">
      {step ? (
        <CodeView text={step} language="javascript" testId="inspector-step" inline />
      ) : (
        <p className="insp-note">{t("noStep")}</p>
      )}
      <div className="insp-actions">
        <CopyButton
          label={t("copyStep")}
          getText={() => step || null}
          disabled={!step}
          testId="inspector-copy-step"
        />
        <button
          type="button"
          className="btn small"
          onClick={() => openGenerate(controller.store, { kind: "playwright", range })}
          data-testid="inspector-playwright"
        >
          <Icon name="code" />
          <span>
            {t("playwrightFrom", { time: formatOffset(range.startMono - minMono, locale) })}
          </span>
        </button>
        <button
          type="button"
          className="btn small"
          onClick={() => openGenerate(controller.store, { kind: "bug-report", range })}
          data-testid="inspector-bug-report"
        >
          <Icon name="report" />
          <span>{t("bugReport")}</span>
        </button>
      </div>
    </Section>
  );
}

function RequestSection({ inspection, t }: PartProps) {
  const controller = useController();
  const archive = usePlayerState((state) => state.archive);
  const reqId = inspection.reqId;
  const entry = reqId ? archive?.model.waterfallByReqId.get(reqId) : undefined;

  if (!reqId || !entry) {
    return null;
  }

  return (
    <Section title={t("sectionRequest")} testId="inspector-request">
      <p className="insp-request">
        {entry.status ? (
          <span className={entry.status >= 400 ? "insp-code bad" : "insp-code"}>
            {entry.status}
          </span>
        ) : null}
        <span className="insp-method">{entry.method}</span>
        <span className="insp-path" title={entry.url}>
          {shortPath(entry.url)}
        </span>
      </p>
      <button
        type="button"
        className="btn small"
        onClick={() => {
          controller.select({ kind: "request", id: reqId });
          controller.setTab("network");
        }}
        data-testid="inspector-open-request"
      >
        <Icon name="req" />
        <span>{t("openRequest")}</span>
      </button>
    </Section>
  );
}

function InspectorBody({ inspection }: { inspection: Inspection }) {
  const t = useFeatureI18n(inspectorMessages);
  const i18n = useI18n();
  const archive = usePlayerState((state) => state.archive);
  const locale = usePlayerState((state) => state.locale);
  const { event } = inspection;
  const row = useMemo(
    () => (archive ? describeFeedEvent(archive, event.id, locale) : null),
    [archive, event.id, locale]
  );
  const title = useMemo(
    () => (archive ? eventTitle(archive, event, locale) : event.type),
    [archive, event, locale]
  );
  const summary = describeInspection(inspection, t, i18n);
  const meta = [
    event.type,
    formatOffset(inspection.offsetMs, locale),
    inspection.actionLabel !== null ? t("actionLabel", { id: inspection.actionLabel }) : ""
  ].filter(Boolean);

  return (
    <div className="insp-body">
      <header className="insp-head">
        <p className="insp-meta" data-testid="inspector-meta">
          <Icon name={row?.glyph ?? "flag"} />
          {meta.join(" · ")}
        </p>
        <h2 className="insp-title" data-testid="inspector-title">
          {title}
        </h2>
        <p className="insp-summary" data-testid="inspector-summary">
          {summary.sentence}
          {summary.outcome ? ` ${summary.outcome}` : ""}
        </p>
      </header>
      <TargetSection inspection={inspection} t={t} />
      <CausedSection inspection={inspection} t={t} />
      <RequestSection inspection={inspection} t={t} />
      <ReproduceSection inspection={inspection} t={t} />
      <Section title={t("sectionRaw")} testId="inspector-raw">
        {inspection.raw.truncated ? (
          <p className="insp-note">
            {t("rawTruncated", { size: i18n.formatByteSize(inspection.raw.text.length) })}
          </p>
        ) : null}
        <div className="insp-actions">
          <CopyButton
            label={t("copyRaw")}
            getText={() => inspection.raw.text}
            testId="inspector-copy-raw"
          />
        </div>
        <CodeView text={inspection.raw.text} language="json" testId="inspector-raw-json" inline />
      </Section>
    </div>
  );
}

/**
 * The event inspector (PROPOSAL §9 B): the selected event's target (outlined on the video), what
 * the action caused, its Playwright step, a one-line summary and the raw event. It replaces the
 * Activity list while open (Enter); "Activity" or Esc goes back, J / L step through the list.
 */
export default function InspectorPanel() {
  const controller = useController();
  const t = useFeatureI18n(inspectorMessages);
  const archive = usePlayerState((state) => state.archive);
  const selection = usePlayerState((state) => state.selection);
  const inspection = useMemo(
    () => (archive ? inspectSelection(archive, selection) : null),
    [archive, selection]
  );
  const ref = useRef<HTMLElement>(null);

  // Opening from the list unmounts it (Enter, double-click): focus moves into the inspector
  // instead of falling back to the page. Focus that is elsewhere (the timeline) stays there.
  useEffect(() => {
    if (!document.activeElement || document.activeElement === document.body) {
      ref.current?.focus({ preventScroll: true });
    }
  }, []);

  if (!archive) {
    return null;
  }

  return (
    <section
      ref={ref}
      className="inspector"
      tabIndex={-1}
      aria-label={t("inspectorLabel")}
      data-testid="inspector"
    >
      <div className="insp-bar">
        <button
          type="button"
          className="btn small"
          aria-label={t("backToListLabel")}
          onClick={() => controller.close()}
          data-testid="inspector-back"
        >
          <Icon name="back" />
          <span>{t("backToList")}</span>
        </button>
        {inspection ? <code className="insp-id">{inspection.event.id}</code> : null}
        <span className="insp-spacer" />
        <Hint label={t("previousEvent")}>
          <button
            type="button"
            className="btn small icon-only"
            aria-label={t("previousEvent")}
            onClick={() => controller.stepList(-1)}
            data-testid="inspector-prev"
          >
            <Icon name="prev" />
          </button>
        </Hint>
        <Hint label={t("nextEvent")}>
          <button
            type="button"
            className="btn small icon-only"
            aria-label={t("nextEvent")}
            onClick={() => controller.stepList(1)}
            data-testid="inspector-next"
          >
            <Icon name="next" />
          </button>
        </Hint>
      </div>
      {inspection ? (
        <InspectorBody inspection={inspection} />
      ) : (
        <p className="insp-note">{t("notInArchive")}</p>
      )}
    </section>
  );
}
