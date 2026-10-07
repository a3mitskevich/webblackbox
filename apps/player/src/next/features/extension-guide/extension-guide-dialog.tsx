import "./extension-guide.css";

import { useEffect, useState } from "react";

import { Icon } from "../../components/icon.js";
import { DialogTitle, ModalDialog } from "../../components/modal-dialog.js";
import { toastManager } from "../../components/toasts.js";
import { useController, useI18n } from "../../context.js";
import { useFeatureI18n } from "../messages.js";
import { useCopyStatus } from "../network/copy-button.js";
import {
  EXTENSION_ZIP_URL,
  fetchExtensionBundleMetadata,
  type ExtensionBundleState
} from "./metadata.js";
import { extensionGuideMessages, type ExtensionGuideMessageKey } from "./messages.js";
import { closeExtensionGuide } from "./slice.js";
import {
  fetchGuideVideos,
  guideVideoUrl,
  pickGuideVideos,
  type GuideVideo,
  type GuideVideoId
} from "./videos.js";

/** This Player's own address, for the extension's "Player URL" option (origin + path). */
function thisPlayerUrl(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

type GuideCopyButtonProps = {
  /** What is copied ("Copy SHA-256"): the accessible name and the toast's description. */
  label: string;
  /** The text copied on click. */
  text: string;
  testId: string;
};

/** A copy button with toast feedback; the status line doubles as the test hook. */
function GuideCopyButton({ label, text, testId }: GuideCopyButtonProps) {
  const t = useFeatureI18n(extensionGuideMessages);
  const [status, copy] = useCopyStatus();

  const handleClick = async (): Promise<void> => {
    const result = await copy(text);

    if (result !== "idle") {
      toastManager.add({
        title: result === "copied" ? t("copied") : t("copyFailed"),
        description: label
      });
    }
  };

  return (
    <span className="xguide-copy">
      <button
        type="button"
        className="btn small"
        aria-label={label}
        onClick={() => void handleClick()}
        data-testid={testId}
      >
        <Icon name="copy" />
        <span>{t("copy")}</span>
      </button>
      <span className="visually-hidden" role="status" data-testid={`${testId}-status`}>
        {status === "copied" ? t("copied") : status === "failed" ? t("copyFailed") : ""}
      </span>
    </span>
  );
}

/**
 * The bundled zip and its checksum, from `extension/extension.json` (written by the build). When
 * the build shipped without the extension, the section says so instead of linking to a 404.
 */
function DownloadSection() {
  const t = useFeatureI18n(extensionGuideMessages);
  const i18n = useI18n();
  const [bundle, setBundle] = useState<ExtensionBundleState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;

    void fetchExtensionBundleMetadata().then((metadata) => {
      if (!cancelled) {
        setBundle(metadata ? { phase: "bundled", metadata } : { phase: "missing" });
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="xguide-section" data-testid="extension-download">
      <h3>{t("downloadTitle")}</h3>
      {bundle.phase === "loading" ? (
        <p className="xguide-note" data-testid="extension-download-checking">
          {t("downloadChecking")}
        </p>
      ) : null}
      {bundle.phase === "missing" ? (
        <div data-testid="extension-download-missing">
          <p>{t("downloadMissing")}</p>
          <p className="xguide-note">{t("downloadMissingHow")}</p>
        </div>
      ) : null}
      {bundle.phase === "bundled" ? (
        <>
          <p>
            <a
              className="btn primary"
              href={EXTENSION_ZIP_URL}
              download={bundle.metadata.file}
              data-testid="extension-download-link"
            >
              <Icon name="download" />
              <span>{t("downloadAction")}</span>
            </a>{" "}
            <span className="xguide-note" data-testid="extension-version">
              {t("downloadFacts", {
                version: bundle.metadata.version,
                size: i18n.formatByteSize(bundle.metadata.size)
              })}
            </span>
          </p>
          <p className="xguide-hash">
            <span className="xguide-hash-label">{t("downloadSha256")}</span>
            <code data-testid="extension-sha256">{bundle.metadata.sha256}</code>
            <GuideCopyButton
              label={t("copySha256")}
              text={bundle.metadata.sha256}
              testId="extension-sha256-copy"
            />
          </p>
        </>
      ) : null}
    </section>
  );
}

const VIDEO_TITLES: Record<GuideVideoId, ExtensionGuideMessageKey> = {
  install: "videoInstall",
  "record-and-export": "videoRecordAndExport",
  "open-in-player": "videoOpenInPlayer"
};

/**
 * The usage videos the build bundled (`extension/videos.json`, from the demo-video recorder), one
 * per topic in the Player's language when available. A build without videos shows no section.
 */
function VideosSection() {
  const t = useFeatureI18n(extensionGuideMessages);
  const i18n = useI18n();
  const [videos, setVideos] = useState<GuideVideo[]>([]);

  useEffect(() => {
    let cancelled = false;

    void fetchGuideVideos().then((list) => {
      if (!cancelled) {
        setVideos(list);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const shown = pickGuideVideos(videos, i18n.locale);

  if (shown.length === 0) {
    return null;
  }

  return (
    <section className="xguide-section" data-testid="extension-videos">
      <h3>{t("videosTitle")}</h3>
      {shown.map((video) => (
        <figure key={video.id} className="xguide-video" data-testid={`extension-video-${video.id}`}>
          <figcaption>
            {t(VIDEO_TITLES[video.id])}
            {video.lang.split("-")[0] !== i18n.locale.split("-")[0] ? (
              <span className="xguide-note">
                {" · "}
                {t("videosCaptions", {
                  language: captionLanguage(i18n.messages.localeNames, video.lang)
                })}
              </span>
            ) : null}
          </figcaption>
          <video controls preload="metadata" src={guideVideoUrl(video)} />
        </figure>
      ))}
    </section>
  );
}

function captionLanguage(names: Readonly<Record<string, string>>, lang: string): string {
  return names[lang] ?? names[lang.split("-")[0] ?? lang] ?? lang;
}

function ConnectSection() {
  const t = useFeatureI18n(extensionGuideMessages);
  const playerUrl = thisPlayerUrl();

  return (
    <section className="xguide-section" data-testid="extension-connect">
      <h3>{t("connectTitle")}</h3>
      <p>{t("connectBody")}</p>
      <p className="xguide-hash">
        <span className="xguide-hash-label">{t("connectThisUrl")}</span>
        <code data-testid="player-url">{playerUrl}</code>
        <GuideCopyButton label={t("copyPlayerUrl")} text={playerUrl} testId="player-url-copy" />
      </p>
      <p className="xguide-note">{t("connectPolicy")}</p>
    </section>
  );
}

/**
 * The extension guide: download, install, connect, record, troubleshoot. Every label it quotes is
 * the extension's or the Player's real UI string (see the PR body for the code references).
 */
export default function ExtensionGuideDialog() {
  const controller = useController();
  const i18n = useI18n();
  const t = useFeatureI18n(extensionGuideMessages);

  return (
    <ModalDialog
      open
      onClose={() => closeExtensionGuide(controller.store)}
      className="dlg-wide xguide"
      testId="extension-guide"
    >
      <div className="dlg-body">
        <DialogTitle>
          <Icon name="puzzle" />
          {t("dialogTitle")}
        </DialogTitle>
        <p>{t("dialogIntro")}</p>

        <DownloadSection />

        <VideosSection />

        <section className="xguide-section">
          <h3>{t("installTitle")}</h3>
          <ol>
            <li>{t("installStepUnzip")}</li>
            <li>{t("installStepOpen")}</li>
            <li>{t("installStepDeveloper")}</li>
            <li>{t("installStepLoad")}</li>
            <li>{t("installStepPin")}</li>
          </ol>
        </section>

        <section className="xguide-section">
          <h3>{t("updateTitle")}</h3>
          <p>{t("updateBody")}</p>
          <p className="xguide-warning" data-testid="extension-update-warning">
            <Icon name="error" />
            <span>{t("updateWarning")}</span>
          </p>
        </section>

        <ConnectSection />

        <section className="xguide-section">
          <h3>{t("recordTitle")}</h3>
          <ol>
            <li>{t("recordStepProfile")}</li>
            <li>{t("recordStepStart")}</li>
            <li>{t("recordStepStop")}</li>
            <li>{t("recordStepPassphrase")}</li>
            <li>{t("recordStepOpen")}</li>
          </ol>
        </section>

        <section className="xguide-section">
          <h3>{t("troubleTitle")}</h3>
          <ul>
            <li>{t("troubleCrypto")}</li>
            <li>{t("troubleIncomplete")}</li>
            <li>{t("troubleErrors")}</li>
          </ul>
        </section>

        <div className="dlg-actions">
          <button
            type="button"
            className="btn primary"
            onClick={() => closeExtensionGuide(controller.store)}
            data-testid="extension-guide-close"
          >
            {i18n.tn("close")}
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}
