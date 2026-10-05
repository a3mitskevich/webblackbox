import "./compare.css";

import {
  alignEndpoints,
  type EndpointAlignment,
  type EndpointSignal,
  type EndpointSummary,
  type NetworkWaterfallEntry,
  type PlayerComparison,
  type StorageComparison
} from "@webblackbox/player-sdk";
import { FileDiff, X } from "lucide-react";
import { useId, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";

import { DialogDescription, DialogTitle, ModalDialog } from "../../components/modal-dialog.js";
import { useController, useI18n, usePlayerState } from "../../context.js";
import type { LoadedArchive } from "../../state.js";
import { useFeatureI18n } from "../messages.js";
import { useFeatureSlice, useFeatureSliceUpdate } from "../slice.js";
import { BodyDiff } from "./body-diff.js";
import {
  cancelComparePassphrase,
  clearCompare,
  dismissCompareError,
  openCompareArchive,
  submitComparePassphrase
} from "./compare-session.js";
import { compareMessages, type CompareTranslate } from "./messages.js";
import { compareSlice, type CompareArchive, type CompareSlice } from "./slice.js";

const ICON_PROPS = { size: 15, strokeWidth: 1.5, absoluteStrokeWidth: true, "aria-hidden": true };
const MAX_REGRESSION_ROWS = 8;
const MAX_TYPE_ROWS = 12;
const SIGNAL_ORDER: readonly EndpointSignal[] = ["regressed", "slower", "new", "missing", "stable"];

const selectWholeSlice = (slice: CompareSlice): CompareSlice => slice;

function CompareFileInput({ label, testId }: { label: string; testId: string }) {
  const { store } = useController();
  const t = useFeatureI18n(compareMessages);
  const inputId = useId();

  const onChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (file) {
      void openCompareArchive(store, file, { unsupportedMessage: t("unsupportedFile") });
    }
  };

  return (
    <>
      <input
        id={inputId}
        className="file-input"
        type="file"
        accept=".webblackbox,.zip"
        onChange={onChange}
        data-testid={testId}
      />
      <label className="btn small" htmlFor={inputId}>
        <FileDiff {...ICON_PROPS} />
        {label}
      </label>
    </>
  );
}

function ComparePassphraseDialog({ fileName, invalid }: { fileName: string; invalid: boolean }) {
  const { store } = useController();
  const t = useFeatureI18n(compareMessages);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (value.trim().length > 0) {
      submitComparePassphrase(store, value);
      setValue("");
    }
  };

  return (
    <ModalDialog
      open
      onClose={() => cancelComparePassphrase(store)}
      initialFocus={inputRef}
      disablePointerDismissal
      testId="compare-passphrase-dialog"
    >
      <form className="dlg-body" onSubmit={submit}>
        <DialogTitle>{t("passphraseTitle")}</DialogTitle>
        <DialogDescription>{t("passphrasePrompt", { fileName })}</DialogDescription>
        {invalid ? (
          <p className="field-error" role="alert" data-testid="compare-passphrase-invalid">
            {t("passphraseInvalid")}
          </p>
        ) : null}
        <label className="field-label">
          {t("passphraseLabel")}
          <input
            ref={inputRef}
            className="text-input"
            type="password"
            autoComplete="off"
            value={value}
            aria-invalid={invalid}
            onChange={(event) => setValue(event.target.value)}
            data-testid="compare-passphrase-input"
          />
        </label>
        <div className="dlg-actions">
          <button type="button" className="btn" onClick={() => cancelComparePassphrase(store)}>
            {t("cancel")}
          </button>
          <button type="submit" className="btn primary" data-testid="compare-passphrase-submit">
            {t("open")}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}

function DeltaCard({
  label,
  value,
  isWorse,
  testId
}: {
  label: string;
  value: string;
  isWorse: boolean;
  testId: string;
}) {
  return (
    <div className={isWorse ? "cmp-card worse" : "cmp-card"} data-testid={testId}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

function describeSide(
  summary: EndpointSummary | null,
  t: CompareTranslate,
  format: (ms: number) => string
): string {
  return summary
    ? t("endpointSide", {
        count: summary.count,
        failed: summary.failureCount,
        p95: format(summary.p95Ms)
      })
    : "—";
}

type ReportProps = {
  archive: LoadedArchive;
  other: CompareArchive;
  selectedKey: string | null;
};

function CompareReport({ archive, other, selectedKey }: ReportProps) {
  const i18n = useI18n();
  const t = useFeatureI18n(compareMessages);
  const update = useFeatureSliceUpdate(compareSlice);
  const [onlyChanged, setOnlyChanged] = useState(true);
  const comparison: PlayerComparison = useMemo(
    () => archive.player.compareWith(other.player),
    [archive, other]
  );
  const storage: StorageComparison = useMemo(
    () => archive.player.compareStorageWith(other.player),
    [archive, other]
  );
  const leftWaterfall = useMemo(() => archive.player.getNetworkWaterfall(), [archive]);
  const rightWaterfall = useMemo(() => other.player.getNetworkWaterfall(), [other]);
  const alignment = useMemo(
    () => alignEndpoints(leftWaterfall, rightWaterfall),
    [leftWaterfall, rightWaterfall]
  );
  const signalCounts = useMemo(
    () =>
      alignment.reduce<Record<EndpointSignal, number>>(
        (counts, row) => ({ ...counts, [row.signal]: counts[row.signal] + 1 }),
        { regressed: 0, slower: 0, new: 0, missing: 0, stable: 0 }
      ),
    [alignment]
  );
  const rows = onlyChanged ? alignment.filter((row) => row.signal !== "stable") : alignment;
  const selected = alignment.find((row) => row.key === selectedKey) ?? null;
  const byReqId = (entries: readonly NetworkWaterfallEntry[], reqId: string | undefined) =>
    reqId ? entries.find((entry) => entry.reqId === reqId) : undefined;
  const ms = (value: number) => i18n.formatMilliseconds(value, { fractionDigits: 0 });
  const signed = (value: number) => i18n.formatNumber(value, { signed: true });
  const regressions = comparison.endpointRegressions
    .filter(
      (entry) => entry.failedDelta > 0 || entry.p95DurationDeltaMs > 0 || entry.countDelta !== 0
    )
    .slice(0, MAX_REGRESSION_ROWS);
  const typeRows = comparison.typeDeltas.filter((row) => row.delta !== 0).slice(0, MAX_TYPE_ROWS);
  const storageRows = storage.kindDeltas.filter((row) => row.delta !== 0);

  const selectRow = (row: EndpointAlignment): void =>
    update((slice) => ({ ...slice, selectedKey: slice.selectedKey === row.key ? null : row.key }));

  return (
    <div className="cmp-report" data-testid="compare-report">
      <div className="cmp-cards">
        <DeltaCard
          label={t("events")}
          value={signed(comparison.eventDelta)}
          isWorse={false}
          testId="compare-delta-events"
        />
        <DeltaCard
          label={t("errors")}
          value={signed(comparison.errorDelta)}
          isWorse={comparison.errorDelta > 0}
          testId="compare-delta-errors"
        />
        <DeltaCard
          label={t("requests")}
          value={signed(comparison.requestDelta)}
          isWorse={false}
          testId="compare-delta-requests"
        />
        <DeltaCard
          label={t("duration")}
          value={i18n.formatSeconds(comparison.durationDeltaMs, { signed: true })}
          isWorse={false}
          testId="compare-delta-duration"
        />
      </div>

      <section className="cmp-section" aria-labelledby="cmp-endpoints">
        <header className="cmp-section-head">
          <h3 id="cmp-endpoints">{t("endpointsHeading")}</h3>
          <span className="cmp-signals">
            {SIGNAL_ORDER.filter((signal) => signalCounts[signal] > 0).map((signal) => (
              <span key={signal} className={`sig sig-${signal}`}>
                {t(`signal_${signal}`)} {i18n.formatNumber(signalCounts[signal])}
              </span>
            ))}
          </span>
          <span className="hdr-spacer" />
          <button
            type="button"
            className="btn small"
            aria-pressed={onlyChanged}
            onClick={() => setOnlyChanged((value) => !value)}
            data-testid="compare-only-changed"
          >
            {t("onlyChanged")}
          </button>
        </header>
        {rows.length === 0 ? (
          <p className="muted">{t("noEndpointChanges")}</p>
        ) : (
          <table className="cmp-table" data-testid="compare-endpoints">
            <thead>
              <tr>
                <th>{t("endpoint")}</th>
                <th>A</th>
                <th>B</th>
                <th>{t("signal")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.key}
                  className={row.key === selectedKey ? "cur" : undefined}
                  aria-selected={row.key === selectedKey}
                  onClick={() => selectRow(row)}
                  data-testid="compare-endpoint-row"
                  data-signal={row.signal}
                >
                  <td className="mono ep" title={row.key}>
                    <button
                      type="button"
                      className="linklike"
                      aria-expanded={row.key === selectedKey}
                      onClick={(event) => {
                        event.stopPropagation();
                        selectRow(row);
                      }}
                    >
                      {row.key}
                    </button>
                  </td>
                  <td className="mono">{describeSide(row.left, t, ms)}</td>
                  <td className="mono">{describeSide(row.right, t, ms)}</td>
                  <td>
                    <span className={`sig sig-${row.signal}`}>{t(`signal_${row.signal}`)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {selected ? (
          <BodyDiff
            left={{
              player: archive.player,
              entry: byReqId(
                leftWaterfall,
                selected.left?.firstBodyReqId ?? selected.left?.firstReqId
              )
            }}
            right={{
              player: other.player,
              entry: byReqId(
                rightWaterfall,
                selected.right?.firstBodyReqId ?? selected.right?.firstReqId
              )
            }}
          />
        ) : null}
      </section>

      <section className="cmp-section" aria-labelledby="cmp-regressions">
        <header className="cmp-section-head">
          <h3 id="cmp-regressions">{t("regressionsHeading")}</h3>
        </header>
        {regressions.length === 0 ? (
          <p className="muted">{t("noRegressions")}</p>
        ) : (
          <table className="cmp-table" data-testid="compare-regressions">
            <thead>
              <tr>
                <th>{t("endpoint")}</th>
                <th>{t("countDelta")}</th>
                <th>{t("failRateDelta")}</th>
                <th>{t("p95Delta")}</th>
              </tr>
            </thead>
            <tbody>
              {regressions.map((entry) => (
                <tr key={`${entry.method} ${entry.endpoint}`}>
                  <td className="mono ep" title={`${entry.method} ${entry.endpoint}`}>
                    {entry.method} {entry.endpoint}
                  </td>
                  <td className="mono">{signed(entry.countDelta)}</td>
                  <td className={entry.failureRateDelta > 0 ? "mono worse" : "mono"}>
                    {i18n.formatNumber(entry.failureRateDelta, {
                      percent: true,
                      signed: true,
                      fractionDigits: 1
                    })}
                  </td>
                  <td className={entry.p95DurationDeltaMs > 0 ? "mono worse" : "mono"}>
                    {i18n.formatMilliseconds(entry.p95DurationDeltaMs, {
                      signed: true,
                      fractionDigits: 0
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="cmp-pair">
        <section className="cmp-section" aria-labelledby="cmp-types">
          <header className="cmp-section-head">
            <h3 id="cmp-types">{t("typesHeading")}</h3>
          </header>
          {typeRows.length === 0 ? (
            <p className="muted">{t("noTypeChanges")}</p>
          ) : (
            <table className="cmp-table" data-testid="compare-types">
              <tbody>
                {typeRows.map((row) => (
                  <tr key={row.type}>
                    <td className="mono">{row.type}</td>
                    <td className="mono num">{i18n.formatNumber(row.left)}</td>
                    <td className="mono num">{i18n.formatNumber(row.right)}</td>
                    <td className="mono num">{signed(row.delta)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="cmp-section" aria-labelledby="cmp-storage">
          <header className="cmp-section-head">
            <h3 id="cmp-storage">{t("storageHeading")}</h3>
          </header>
          {storageRows.length === 0 ? (
            <p className="muted">{t("noStorageChanges")}</p>
          ) : (
            <table className="cmp-table" data-testid="compare-storage">
              <tbody>
                {storageRows.map((row) => (
                  <tr key={row.kind}>
                    <td className="mono">{row.kind}</td>
                    <td className="mono num">{i18n.formatNumber(row.left)}</td>
                    <td className="mono num">{i18n.formatNumber(row.right)}</td>
                    <td className="mono num">{signed(row.delta)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * Compare (R4, own chunk): the open archive (A) against another recording (B): deltas, endpoints
 * side by side with their signal, the response diff of a picked endpoint, regressions, event
 * types and storage. jsdiff and microdiff load with this panel only.
 */
export function ComparePanel() {
  const { store } = useController();
  const t = useFeatureI18n(compareMessages);
  const archive = usePlayerState((state) => state.archive);
  const slice = useFeatureSlice(compareSlice, selectWholeSlice);
  const { status, other } = slice;

  if (!archive) {
    return null;
  }

  return (
    <div className="cmp" data-testid="compare-panel">
      <div className="rail-tools cmp-tools">
        <span className="cmp-side">
          <b>A</b>
          <span className="mono" title={archive.fileName}>
            {archive.fileName}
          </span>
        </span>
        <span className="cmp-side">
          <b>B</b>
          {other ? (
            <span className="mono" title={other.fileName} data-testid="compare-file-name">
              {other.fileName}
            </span>
          ) : (
            <span className="muted">{t("noCompareArchive")}</span>
          )}
        </span>
        <span className="hdr-spacer" />
        <CompareFileInput label={other ? t("change") : t("openCompare")} testId="compare-input" />
        {other ? (
          <button
            type="button"
            className="btn small icon-only"
            aria-label={t("clear")}
            onClick={() => clearCompare(store)}
            data-testid="compare-clear"
          >
            <X {...ICON_PROPS} />
          </button>
        ) : null}
      </div>
      {status.phase === "loading" ? (
        <p className="status-line" role="status" data-testid="compare-loading">
          {t("loading", { fileName: status.fileName })}
        </p>
      ) : null}
      {status.phase === "error" ? (
        <p className="status-line bad" role="alert" data-testid="compare-error">
          {t("loadFailed", { fileName: status.fileName, error: status.message })}{" "}
          <button type="button" className="btn small" onClick={() => dismissCompareError(store)}>
            {t("dismiss")}
          </button>
        </p>
      ) : null}
      {status.phase === "passphrase" ? (
        <ComparePassphraseDialog fileName={status.fileName} invalid={status.invalid} />
      ) : null}
      {other ? (
        <CompareReport archive={archive} other={other} selectedKey={slice.selectedKey} />
      ) : status.phase === "empty" ? (
        <div className="cmp-empty" data-testid="compare-empty">
          <p>{t("emptyTitle")}</p>
          <p className="muted">{t("emptyHint")}</p>
        </div>
      ) : null}
    </div>
  );
}

export default ComparePanel;
