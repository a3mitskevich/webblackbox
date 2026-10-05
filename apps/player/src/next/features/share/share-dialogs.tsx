import { Copy, ShieldAlert } from "lucide-react";
import { useId, useMemo, useRef, useState, type FormEvent } from "react";

import { copyText } from "../../../lib/export.js";
import { DialogDescription, DialogTitle, ModalDialog } from "../../components/modal-dialog.js";
import { useController, useI18n, usePlayerState } from "../../context.js";
import type { LoadedArchive } from "../../state.js";
import { useFeatureI18n } from "../messages.js";
import { useFeatureSlice } from "../slice.js";
import { shareMessages, type ShareTranslate } from "./messages.js";
import {
  apiKeyFor,
  browserShareSettings,
  loadSharedArchive,
  ShareError,
  uploadArchive
} from "./share-service.js";
import { shareSlice, type ShareSlice } from "./slice.js";

const ICON_PROPS = { size: 15, strokeWidth: 1.5, absoluteStrokeWidth: true, "aria-hidden": true };
const PREVIEW_SAMPLES = 5;
const selectWholeSlice = (slice: ShareSlice): ShareSlice => slice;

function PrivacyPreflight({ archive, t }: { archive: LoadedArchive; t: ShareTranslate }) {
  const i18n = useI18n();
  const { report, preview } = useMemo(
    () => ({
      report: archive.player.getPrivacyProtectionReport(),
      preview: archive.player.getSensitiveDataPreview({ limit: PREVIEW_SAMPLES })
    }),
    [archive]
  );

  return (
    <section
      className="share-preflight"
      aria-label={t("preflightTitle")}
      data-testid="share-preflight"
    >
      <h3>
        <ShieldAlert {...ICON_PROPS} />
        {t("preflightTitle")}
      </h3>
      <ul>
        <li>
          {t("preflightProfile", {
            headers: report.redaction.headers.length,
            cookies: report.redaction.cookieNames.length,
            patterns: report.redaction.bodyPatterns.length
          })}
        </li>
        <li>
          {t("preflightDetected", {
            markers: report.detected.redactedMarkers,
            hashes: report.detected.hashedSensitiveValues,
            mentions: report.detected.sensitiveKeyMentions
          })}
        </li>
        <li data-testid="share-preflight-matches">
          {t("preflightMatches", { matches: preview.totalMatches })}
        </li>
      </ul>
      {preview.samples.length > 0 ? (
        <ol className="share-samples" data-testid="share-preflight-samples">
          {preview.samples.slice(0, PREVIEW_SAMPLES).map((sample) => (
            <li key={`${sample.eventId}-${sample.reason}`}>
              <span className="tag">{i18n.formatSensitiveReason(sample.reason)}</span>
              <code>{sample.snippet}</code>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">{t("preflightNoSamples")}</p>
      )}
    </section>
  );
}

function UploadDialog({ archive }: { archive: LoadedArchive }) {
  const controller = useController();
  const i18n = useI18n();
  const t = useFeatureI18n(shareMessages);
  const locale = usePlayerState((state) => state.locale);
  const { upload } = useFeatureSlice(shareSlice, selectWholeSlice);
  const [baseUrl, setBaseUrl] = useState(() => browserShareSettings.readBaseUrl());
  const [apiKey, setApiKey] = useState(() => apiKeyFor(browserShareSettings, baseUrl));
  const [reviewed, setReviewed] = useState(false);
  const serverRef = useRef<HTMLInputElement>(null);
  const reviewedId = useId();
  const close = () => shareSlice.update(controller.store, (slice) => ({ ...slice, dialog: null }));
  const setUpload = (next: ShareSlice["upload"]) =>
    shareSlice.update(controller.store, (slice) => ({ ...slice, upload: next }));

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    if (!reviewed || upload.phase === "uploading") {
      return;
    }

    setUpload({ phase: "uploading", loaded: 0, total: archive.bytes.byteLength });

    try {
      const shareUrl = await uploadArchive({
        baseUrl,
        apiKey,
        fileName: archive.fileName,
        bytes: archive.bytes,
        player: archive.player,
        locale,
        onProgress: ({ loaded, total }) => setUpload({ phase: "uploading", loaded, total })
      });
      setUpload({ phase: "done", shareUrl });
      const copied = await copyText(shareUrl).then(
        () => true,
        () => false
      );
      controller.store.setState((state) => ({
        ...state,
        announcement: copied ? t("linkCopied") : t("uploaded")
      }));
    } catch (error) {
      const message =
        error instanceof ShareError && error.code === "invalid-server"
          ? t("invalidServer")
          : t("uploadFailed", { error: error instanceof Error ? error.message : String(error) });
      setUpload({ phase: "error", message });
    }
  };

  const percent =
    upload.phase === "uploading" && upload.total > 0
      ? Math.min(100, (upload.loaded / upload.total) * 100)
      : 0;

  return (
    <ModalDialog
      open
      onClose={close}
      className="dlg-wide"
      initialFocus={serverRef}
      disablePointerDismissal
      testId="share-upload-dialog"
    >
      <form className="dlg-body share-form" onSubmit={(event) => void submit(event)}>
        <DialogTitle>{t("uploadTitle")}</DialogTitle>
        <DialogDescription>
          {t("uploadDescription", { fileName: archive.fileName })}
        </DialogDescription>
        <label className="field-label">
          {t("serverUrl")}
          <input
            ref={serverRef}
            className="text-input"
            type="url"
            value={baseUrl}
            onChange={(event) => {
              setBaseUrl(event.target.value);
              setApiKey(apiKeyFor(browserShareSettings, event.target.value));
            }}
            data-testid="share-server-url"
          />
        </label>
        <label className="field-label">
          {t("apiKey")}
          <input
            className="text-input"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            data-testid="share-api-key"
          />
        </label>
        <PrivacyPreflight archive={archive} t={t} />
        <label className="share-check" htmlFor={reviewedId}>
          <input
            id={reviewedId}
            type="checkbox"
            checked={reviewed}
            onChange={(event) => setReviewed(event.target.checked)}
            data-testid="share-reviewed"
          />
          {t("reviewed")}
        </label>
        {upload.phase === "uploading" ? (
          <div className="share-progress" role="status" data-testid="share-progress">
            <progress max={100} value={percent} />
            <span>
              {t("uploading", {
                percent: i18n.formatNumber(percent, { fractionDigits: 0 }),
                loaded: i18n.formatByteSize(upload.loaded),
                total: i18n.formatByteSize(upload.total)
              })}
            </span>
          </div>
        ) : null}
        {upload.phase === "error" ? (
          <p className="field-error" role="alert" data-testid="share-upload-error">
            {upload.message}
          </p>
        ) : null}
        {upload.phase === "done" ? (
          <div className="share-result" data-testid="share-result">
            <input
              className="text-input mono"
              readOnly
              value={upload.shareUrl}
              data-testid="share-url"
            />
            <button
              type="button"
              className="btn"
              onClick={() =>
                void copyText(upload.shareUrl).then(() =>
                  controller.store.setState((state) => ({
                    ...state,
                    announcement: t("linkCopied")
                  }))
                )
              }
              data-testid="share-copy"
            >
              <Copy {...ICON_PROPS} />
              {t("copyLink")}
            </button>
          </div>
        ) : null}
        <div className="dlg-actions">
          <button type="button" className="btn" onClick={close}>
            {upload.phase === "done" ? t("done") : t("cancel")}
          </button>
          {upload.phase !== "done" ? (
            <button
              type="submit"
              className="btn primary"
              disabled={!reviewed || upload.phase === "uploading"}
              data-testid="share-upload-submit"
            >
              {t("upload")}
            </button>
          ) : null}
        </div>
      </form>
    </ModalDialog>
  );
}

function OpenSharedDialog({
  reference,
  untrustedOrigin
}: {
  reference: string;
  untrustedOrigin?: string;
}) {
  const controller = useController();
  const t = useFeatureI18n(shareMessages);
  const { open } = useFeatureSlice(shareSlice, selectWholeSlice);
  const [value, setValue] = useState(
    () => reference || `${browserShareSettings.readBaseUrl()}/share/`
  );
  const [apiKey, setApiKey] = useState("");
  const referenceRef = useRef<HTMLInputElement>(null);
  const close = () =>
    shareSlice.update(controller.store, (slice) => ({
      ...slice,
      dialog: null,
      open: { phase: "idle" }
    }));

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (open.phase === "loading" || !value.trim()) {
      return;
    }

    void loadSharedArchive(controller, {
      reference: value,
      apiKey,
      // A link from the address bar never changes the saved server or keys.
      persist: !untrustedOrigin,
      messages: { failed: (error) => t("loadFailed", { error }), invalid: t("invalidReference") }
    });
  };

  return (
    <ModalDialog
      open
      onClose={close}
      initialFocus={referenceRef}
      disablePointerDismissal
      testId="share-open-dialog"
    >
      <form className="dlg-body share-form" onSubmit={submit}>
        <DialogTitle>{t("openTitle")}</DialogTitle>
        <DialogDescription>
          {untrustedOrigin
            ? t("untrustedOrigin", { origin: untrustedOrigin })
            : t("openDescription")}
        </DialogDescription>
        {untrustedOrigin ? (
          <p className="share-warning" role="alert" data-testid="share-untrusted">
            <ShieldAlert {...ICON_PROPS} />
            {untrustedOrigin}
          </p>
        ) : null}
        <label className="field-label">
          {t("reference")}
          <input
            ref={referenceRef}
            className="text-input"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            data-testid="share-reference"
          />
        </label>
        <label className="field-label">
          {t("apiKey")}
          <input
            className="text-input"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            data-testid="share-open-api-key"
          />
        </label>
        {open.phase === "error" ? (
          <p className="field-error" role="alert" data-testid="share-open-error">
            {open.message}
          </p>
        ) : null}
        <div className="dlg-actions">
          <button type="button" className="btn" onClick={close}>
            {t("cancel")}
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={open.phase === "loading"}
            data-testid="share-open-submit"
          >
            {open.phase === "loading" ? t("opening") : t("open")}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}

/** The share dialog the slice asks for (own chunk, loaded on first use). */
export function ShareDialogs() {
  const archive = usePlayerState((state) => state.archive);
  const { dialog } = useFeatureSlice(shareSlice, selectWholeSlice);

  if (dialog?.kind === "upload") {
    return archive ? <UploadDialog archive={archive} /> : null;
  }

  if (dialog?.kind === "open") {
    return (
      <OpenSharedDialog reference={dialog.reference} untrustedOrigin={dialog.untrustedOrigin} />
    );
  }

  return null;
}

export default ShareDialogs;
