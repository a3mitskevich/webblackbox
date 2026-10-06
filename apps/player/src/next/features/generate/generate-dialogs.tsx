import "../network/viewers.css";

import { Download, RefreshCw } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

import type { TimeRange } from "../../../core/time-range.js";
import { downloadTextFile } from "../../../lib/export.js";
import { DialogDescription, DialogTitle, ModalDialog } from "../../components/modal-dialog.js";
import { toastManager } from "../../components/toasts.js";
import { useController, useI18n, usePlayerState } from "../../context.js";
import type { LoadedArchive } from "../../state.js";
import { useFeatureI18n } from "../messages.js";
import { CodeView } from "../network/code-view.js";
import { CopyButton } from "../network/copy-button.js";
import type { HighlightLanguage } from "../network/highlight.js";
import { useFeatureSlice } from "../slice.js";
import { closeGenerate, generateSlice, type GenerateKind, type GenerateSlice } from "./api.js";
import {
  buildBugReport,
  buildGitHubIssue,
  buildHar,
  buildJiraIssue,
  buildPlaywrightMockScript,
  buildPlaywrightScript,
  GENERATE_FILE_NAMES,
  MAX_MOCKS,
  resolveStartUrl
} from "./generators.js";
import { generateMessages, type GenerateMessageKey, type GenerateTranslate } from "./messages.js";
import { clampMaxActions, DEFAULT_MAX_ACTIONS, resolveGenerateRange } from "./range.js";
import { RangeFields } from "./range-fields.js";
import { useGenerated, type Output } from "./use-generated.js";

const ICON_PROPS = { size: 15, strokeWidth: 1.5, absoluteStrokeWidth: true, "aria-hidden": true };

const TITLES: Record<GenerateKind, GenerateMessageKey> = {
  playwright: "titlePlaywright",
  "playwright-mocks": "titlePlaywrightMocks",
  "bug-report": "titleBugReport",
  har: "titleHar",
  "github-issue": "titleGitHubIssue",
  "jira-issue": "titleJiraIssue"
};

const DESCRIPTIONS: Record<GenerateKind, GenerateMessageKey> = {
  playwright: "describePlaywright",
  "playwright-mocks": "describePlaywrightMocks",
  "bug-report": "describeBugReport",
  har: "describeHar",
  "github-issue": "describeGitHubIssue",
  "jira-issue": "describeJiraIssue"
};

type DownloadButtonProps = {
  fileName: string;
  getContent: () => string | null;
  mime: string;
  t: GenerateTranslate;
  testId?: string;
};

function DownloadButton({ fileName, getContent, mime, t, testId }: DownloadButtonProps) {
  const [saved, setSaved] = useState(false);

  const handleClick = (): void => {
    const content = getContent();

    if (content === null) {
      return;
    }

    downloadTextFile(fileName, content.endsWith("\n") ? content : `${content}\n`, mime);
    setSaved(true);
    toastManager.add({ title: t("downloaded", { fileName }) });
  };

  return (
    <>
      <button
        type="button"
        className="btn small"
        disabled={getContent() === null}
        onClick={handleClick}
        data-testid={testId}
      >
        <Download {...ICON_PROPS} />
        <span>{t("download")}</span>
      </button>
      <span className="visually-hidden" data-testid={testId ? `${testId}-status` : undefined}>
        {saved ? t("downloaded", { fileName }) : ""}
      </span>
    </>
  );
}

function OutputPreview({
  output,
  language,
  t,
  testId = "generate-preview"
}: {
  output: Output<string>;
  language: "plain" | HighlightLanguage;
  t: GenerateTranslate;
  testId?: string;
}) {
  if (output.status === "pending") {
    return (
      <p className="gen-status" role="status" data-testid="generate-pending">
        {t("generating")}
      </p>
    );
  }

  if (output.status === "error") {
    return (
      <p className="field-error" role="alert" data-testid="generate-error">
        {t("failed", { error: output.message })}
      </p>
    );
  }

  return (
    <div className="gen-preview" aria-label={t("preview")} role="group">
      <CodeView text={output.value} language={language} testId={testId} />
    </div>
  );
}

type DialogFrameProps = {
  kind: GenerateKind;
  onClose: () => void;
  onSubmit?: () => void;
  description?: string;
  children: ReactNode;
  actions: ReactNode;
  t: GenerateTranslate;
};

function DialogFrame({
  kind,
  onClose,
  onSubmit,
  description,
  children,
  actions,
  t
}: DialogFrameProps) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onSubmit?.();
  };

  return (
    <ModalDialog open onClose={onClose} className="gen-dlg" testId={`generate-dialog-${kind}`}>
      <form className="dlg-body gen-body" onSubmit={handleSubmit}>
        <DialogTitle>{t(TITLES[kind])}</DialogTitle>
        <DialogDescription>{description ?? t(DESCRIPTIONS[kind])}</DialogDescription>
        {children}
        <div className="dlg-actions gen-actions">
          {actions}
          <button type="button" className="btn" onClick={onClose} data-testid="generate-close">
            {t("close")}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}

type GeneratorProps = {
  archive: LoadedArchive;
  initialRange: TimeRange | null;
  timelineRange: TimeRange | null;
  onClose: () => void;
  t: GenerateTranslate;
};

function PlaywrightDialog({ mocks, ...props }: GeneratorProps & { mocks: boolean }) {
  const { archive, initialRange, timelineRange, onClose, t } = props;
  const kind: GenerateKind = mocks ? "playwright-mocks" : "playwright";
  const [range, setRange] = useState(initialRange);
  const [maxActionsText, setMaxActionsText] = useState(String(DEFAULT_MAX_ACTIONS));
  const [maxActions, setMaxActions] = useState(DEFAULT_MAX_ACTIONS);
  const [includeHarReplay, setIncludeHarReplay] = useState(true);
  const maxActionsId = useId();
  const harId = useId();
  // Scans every event (route chapters): once per range, not on each keystroke in Max actions.
  const startUrl = useMemo(() => resolveStartUrl(archive, range), [archive, range]);

  const job = useMemo(
    () =>
      mocks
        ? () => buildPlaywrightMockScript(archive, { range, maxActions, startUrl })
        : () => buildPlaywrightScript(archive, { range, maxActions, includeHarReplay, startUrl }),
    [archive, mocks, range, maxActions, includeHarReplay, startUrl]
  );
  const output = useGenerated(job);
  const text = output.status === "ready" ? output.value : null;

  const commitMaxActions = (): void => {
    const next = clampMaxActions(Number.parseFloat(maxActionsText));
    setMaxActionsText(String(next));
    setMaxActions(next);
  };

  return (
    <DialogFrame
      kind={kind}
      onClose={onClose}
      onSubmit={commitMaxActions}
      description={t(DESCRIPTIONS[kind], { count: MAX_MOCKS, fileName: GENERATE_FILE_NAMES.har })}
      t={t}
      actions={
        <>
          <button
            type="submit"
            className="btn small"
            onClick={commitMaxActions}
            data-testid="generate-regenerate"
          >
            <RefreshCw {...ICON_PROPS} />
            <span>{t("regenerate")}</span>
          </button>
          <CopyButton
            label={t("copy")}
            getText={() => text}
            disabled={text === null}
            testId="generate-copy"
          />
          <DownloadButton
            fileName={GENERATE_FILE_NAMES[kind]}
            getContent={() => text}
            mime="text/plain"
            t={t}
            testId="generate-download"
          />
        </>
      }
    >
      <RangeFields
        archive={archive}
        range={range}
        timelineRange={timelineRange}
        onChange={setRange}
        t={t}
      />
      <div className="gen-options">
        <label className="gen-field" htmlFor={maxActionsId}>
          {t("maxActions")}
          <input
            id={maxActionsId}
            className="text-input gen-number"
            type="number"
            min={1}
            max={500}
            value={maxActionsText}
            onChange={(event) => setMaxActionsText(event.target.value)}
            onBlur={commitMaxActions}
            data-testid="generate-max-actions"
          />
        </label>
        {mocks ? null : (
          <label className="gen-check" htmlFor={harId}>
            <input
              id={harId}
              type="checkbox"
              checked={includeHarReplay}
              onChange={(event) => setIncludeHarReplay(event.target.checked)}
              data-testid="generate-include-har"
            />
            {t("includeHar", { fileName: GENERATE_FILE_NAMES.har })}
          </label>
        )}
        <span className="gen-start" data-testid="generate-start-url">
          {t("startsAt", { url: startUrl })}
        </span>
      </div>
      <OutputPreview output={output} language="javascript" t={t} />
    </DialogFrame>
  );
}

function BugReportDialog(props: GeneratorProps) {
  const { archive, initialRange, timelineRange, onClose, t } = props;
  const [range, setRange] = useState(initialRange);
  const job = useMemo(() => () => buildBugReport(archive, range), [archive, range]);
  const output = useGenerated(job);
  const text = output.status === "ready" ? output.value : null;

  return (
    <DialogFrame
      kind="bug-report"
      onClose={onClose}
      t={t}
      actions={
        <>
          <CopyButton
            label={t("copy")}
            getText={() => text}
            disabled={text === null}
            testId="generate-copy"
          />
          <DownloadButton
            fileName={GENERATE_FILE_NAMES["bug-report"]}
            getContent={() => text}
            mime="text/markdown"
            t={t}
            testId="generate-download"
          />
        </>
      }
    >
      <RangeFields
        archive={archive}
        range={range}
        timelineRange={timelineRange}
        onChange={setRange}
        t={t}
      />
      <OutputPreview output={output} language="markdown" t={t} />
    </DialogFrame>
  );
}

function HarDialog(props: GeneratorProps) {
  const { archive, initialRange, timelineRange, onClose, t } = props;
  const i18n = useI18n();
  const [range, setRange] = useState(initialRange);
  const job = useMemo(() => () => buildHar(archive, range), [archive, range]);
  const output = useGenerated(job);
  const har = output.status === "ready" ? output.value : null;
  const text: Output<string> =
    output.status === "ready" ? { status: "ready", value: output.value.text } : output;

  return (
    <DialogFrame
      kind="har"
      onClose={onClose}
      t={t}
      actions={
        <>
          <CopyButton
            label={t("copy")}
            getText={() => har?.text ?? null}
            disabled={har === null}
            testId="generate-copy"
          />
          <DownloadButton
            fileName={GENERATE_FILE_NAMES.har}
            getContent={() => har?.text ?? null}
            mime="application/json"
            t={t}
            testId="generate-download"
          />
        </>
      }
    >
      <RangeFields
        archive={archive}
        range={range}
        timelineRange={timelineRange}
        onChange={setRange}
        t={t}
      />
      {har ? (
        <p className="gen-status" data-testid="generate-har-summary">
          {t("harSummary", {
            count: i18n.formatNumber(har.entries),
            size: i18n.formatByteSize(har.bytes)
          })}
        </p>
      ) : null}
      <OutputPreview output={text} language="json" t={t} />
    </DialogFrame>
  );
}

type IssueView = {
  title: string;
  type: string | null;
  labels: readonly string[];
  body: string;
  payload: string;
};

function IssueDialog({ jira, ...props }: GeneratorProps & { jira: boolean }) {
  const { archive, initialRange, timelineRange, onClose, t } = props;
  const kind: GenerateKind = jira ? "jira-issue" : "github-issue";
  const [range, setRange] = useState(initialRange);
  const job = useMemo(
    () => (): IssueView => {
      if (jira) {
        const issue = buildJiraIssue(archive, range);
        return {
          title: issue.fields.summary,
          type: issue.fields.issuetype.name,
          labels: issue.fields.labels,
          body: issue.fields.description,
          payload: JSON.stringify(issue, null, 2)
        };
      }

      const issue = buildGitHubIssue(archive, range);
      return {
        title: issue.title,
        type: null,
        labels: issue.labels,
        body: issue.body,
        payload: JSON.stringify(issue, null, 2)
      };
    },
    [archive, jira, range]
  );
  const output = useGenerated(job);
  const issue = output.status === "ready" ? output.value : null;
  const body: Output<string> =
    output.status === "ready" ? { status: "ready", value: output.value.body } : output;
  const titleId = useId();

  return (
    <DialogFrame
      kind={kind}
      onClose={onClose}
      t={t}
      actions={
        <>
          <CopyButton
            label={t("copyTitle")}
            getText={() => issue?.title ?? null}
            disabled={issue === null}
            testId="generate-copy-title"
          />
          <CopyButton
            label={t("copyBody")}
            getText={() => issue?.body ?? null}
            disabled={issue === null}
            testId="generate-copy"
          />
          <DownloadButton
            fileName={GENERATE_FILE_NAMES[kind]}
            getContent={() => issue?.payload ?? null}
            mime="application/json"
            t={t}
            testId="generate-download"
          />
        </>
      }
    >
      <RangeFields
        archive={archive}
        range={range}
        timelineRange={timelineRange}
        onChange={setRange}
        t={t}
      />
      {issue ? (
        <div className="gen-issue" data-testid="generate-issue">
          <label className="gen-field" htmlFor={titleId}>
            {jira ? t("issueSummary") : t("issueTitle")}
            <input
              id={titleId}
              className="text-input"
              readOnly
              value={issue.title}
              data-testid="generate-issue-title"
            />
          </label>
          {issue.type ? (
            <p className="gen-meta">
              {t("issueType")}
              <span className="chip">{issue.type}</span>
            </p>
          ) : null}
          <p className="gen-meta" data-testid="generate-issue-labels">
            {t("issueLabels")}
            {issue.labels.map((label) => (
              <span key={label} className="chip">
                {label}
              </span>
            ))}
          </p>
          <span className="gen-meta">{jira ? t("issueDescription") : t("issueBody")}</span>
        </div>
      ) : null}
      <OutputPreview output={body} language="markdown" t={t} />
    </DialogFrame>
  );
}

const selectRequest = (slice: GenerateSlice) => slice.request;

/**
 * The open generator's dialog. It starts from the request's range (the inspector's "Playwright
 * from 9.45 s"), else the timeline range, else the whole session; the range is then the dialog's
 * own until it closes. Opening another archive closes it.
 */
export default function GenerateDialogsHost() {
  const controller = useController();
  const t = useFeatureI18n(generateMessages);
  const request = useFeatureSlice(generateSlice, selectRequest);
  const archive = usePlayerState((state) => state.archive);
  const timelineRange = usePlayerState((state) => state.range);
  const openedWith = useRef(archive);

  useEffect(() => {
    if (openedWith.current !== archive) {
      openedWith.current = archive;
      closeGenerate(controller.store);
    }
  }, [archive, controller]);

  if (!request || !archive || openedWith.current !== archive) {
    return null;
  }

  const props: GeneratorProps = {
    archive,
    initialRange: resolveGenerateRange(request, timelineRange),
    timelineRange,
    onClose: () => closeGenerate(controller.store),
    t
  };

  switch (request.kind) {
    case "playwright":
      return <PlaywrightDialog key="playwright" mocks={false} {...props} />;
    case "playwright-mocks":
      return <PlaywrightDialog key="playwright-mocks" mocks {...props} />;
    case "bug-report":
      return <BugReportDialog {...props} />;
    case "har":
      return <HarDialog {...props} />;
    case "github-issue":
      return <IssueDialog key="github" jira={false} {...props} />;
    case "jira-issue":
      return <IssueDialog key="jira" jira {...props} />;
  }
}
