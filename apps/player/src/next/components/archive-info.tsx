import type { BodySkipReason } from "@webblackbox/protocol";
import { useMemo, type ReactNode } from "react";

import {
  buildArchiveContents,
  type ArchiveContents,
  type ContentStatus
} from "../../core/archive-contents.js";
import { formatRecordedAt } from "../../core/format.js";
import type { NextMessageKey, PlayerI18n } from "../../lib/i18n.js";
import { formatRecordingProfileBanner } from "../../lib/recording-profile-view.js";
import { useController, useI18n, usePlayerState } from "../context.js";
import type { LoadedArchive } from "../state.js";
import { Icon } from "./icon.js";
import { DialogTitle, ModalDialog } from "./modal-dialog.js";

const contentsCache = new WeakMap<LoadedArchive, ArchiveContents>();

/** What the archive contains, built once per archive (player-sdk completeness + the model). */
export function archiveContentsOf(archive: LoadedArchive): ArchiveContents {
  let contents = contentsCache.get(archive);

  if (!contents) {
    contents = buildArchiveContents(
      archive.player.events,
      archive.model,
      archive.player.getCaptureCompleteness()
    );
    contentsCache.set(archive, contents);
  }

  return contents;
}

const STATUS_KEYS: Record<ContentStatus, NextMessageKey> = {
  full: "statusFull",
  partial: "statusPartial",
  none: "statusNone"
};

const REASON_KEYS: Record<BodySkipReason, NextMessageKey> = {
  filtered: "reasonFiltered",
  "mime-not-allowed": "reasonMimeNotAllowed",
  "too-large": "reasonTooLarge",
  "session-limit": "reasonSessionLimit",
  backlog: "reasonBacklog",
  "not-retained": "reasonNotRetained",
  unavailable: "reasonUnavailable",
  "fetch-failed": "reasonFetchFailed",
  empty: "reasonEmpty"
};

/** Banner lines for a downgraded, capped or cancelled recording profile (empty when fine). */
export function profileBannerLines(archive: LoadedArchive, i18n: PlayerI18n): string[] {
  const contents = archiveContentsOf(archive);
  return formatRecordingProfileBanner(contents.profiles, contents.cancellation, i18n);
}

/** Joins the non-empty sentences of a fact. */
function sentences(...parts: string[]): string {
  return parts.filter(Boolean).join(" ");
}

type FactProps = {
  id: string;
  title: string;
  status: ContentStatus;
  children: ReactNode;
};

function Fact({ id, title, status, children }: FactProps) {
  const i18n = useI18n();

  return (
    <li className={`fact fact-${status}`} data-testid={`contents-${id}`} data-status={status}>
      <span className="fact-dot" aria-hidden="true" />
      <div>
        <p className="fact-title">
          {title} <span className="fact-status">· {i18n.tn(STATUS_KEYS[status])}</span>
        </p>
        <p className="fact-text">{children}</p>
      </div>
    </li>
  );
}

function ContentsList({ contents }: { contents: ArchiveContents }) {
  const i18n = useI18n();
  const locale = usePlayerState((state) => state.locale);
  const n = (value: number): string => i18n.formatNumber(value);
  const { media, network, realtime, console, storage, dom, perf } = contents;
  const bodies = network.bodies;
  const reasons = Object.entries(bodies.skipReasons)
    .flatMap(([reason, count]) => {
      const key = REASON_KEYS[reason as BodySkipReason];
      return count && key ? [`${i18n.tn(key)} ${n(count)}`] : [];
    })
    .join(", ");
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });

  return (
    <ul className="facts" data-testid="archive-contents">
      <Fact id="media" title={i18n.tn("contentsMedia")} status={media.status}>
        {media.kind === "video"
          ? i18n.tn("mediaVideo", {
              resolution: media.width && media.height ? `${media.width}×${media.height}` : "",
              chunks: n(media.chunks),
              size: i18n.formatByteSize(media.bytes)
            })
          : media.kind === "screenshots"
            ? i18n.tn("mediaScreenshots", { count: n(media.count) })
            : i18n.tn("mediaNone")}
      </Fact>
      <Fact id="network" title={i18n.tn("contentsNetwork")} status={network.status}>
        {network.requests === 0
          ? i18n.tn("networkNone")
          : sentences(
              i18n.tn("networkSummary", {
                requests: n(network.requests),
                captured: n(bodies.captured),
                expected: n(bodies.expected)
              }),
              network.bodiesRequested ? "" : i18n.tn("networkNoBodies"),
              bodies.truncated > 0 ? i18n.tn("networkCut", { count: n(bodies.truncated) }) : "",
              reasons ? i18n.tn("networkSkipped", { reasons }) : "",
              bodies.missing > 0 ? i18n.tn("networkMissing", { count: n(bodies.missing) }) : ""
            )}
      </Fact>
      <Fact id="realtime" title={i18n.tn("contentsRealtime")} status={realtime.status}>
        {realtime.status === "none"
          ? i18n.tn("realtimeNone")
          : sentences(
              i18n.tn("realtimeSummary", {
                frames: n(realtime.frames),
                sse: n(realtime.sseMessages)
              }),
              realtime.cut + realtime.incomplete > 0
                ? i18n.tn("realtimeCut", {
                    cut: n(realtime.cut),
                    incomplete: n(realtime.incomplete)
                  })
                : ""
            )}
      </Fact>
      <Fact id="console" title={i18n.tn("contentsConsole")} status={console.status}>
        {console.status === "none"
          ? i18n.tn("consoleNone")
          : sentences(
              i18n.tn("consoleSummary", {
                entries: n(console.entries),
                errors: n(console.errors),
                withStack: n(console.withStack)
              }),
              console.withStack < console.errors ? i18n.tn("consoleTopFrame") : "",
              console.truncated > 0
                ? i18n.tn("consoleTruncated", { count: n(console.truncated) })
                : ""
            )}
      </Fact>
      <Fact id="storage" title={i18n.tn("contentsStorage")} status={storage.status}>
        {storage.status === "none"
          ? i18n.tn("storageNone")
          : sentences(
              i18n.tn("storageSummary", {
                cookieSnapshots: n(storage.cookieSnapshots),
                cookieValues: n(storage.cookieValues),
                localSnapshots: n(storage.localSnapshots),
                localValues: n(storage.localValues),
                idbSnapshots: n(storage.idbSnapshots),
                idbRecords: n(storage.idbRecords)
              }),
              storage.status === "partial" ? i18n.tn("storageNamesOnly") : ""
            )}
      </Fact>
      <Fact id="dom" title={i18n.tn("contentsDom")} status={dom.status}>
        {dom.status === "none"
          ? i18n.tn("domNone")
          : i18n.tn("domSummary", {
              snapshots: n(dom.snapshots),
              batches: n(dom.mutationBatches),
              coverage: percent.format(dom.coverage),
              gap: i18n.formatSeconds(dom.longestGapMs)
            })}
      </Fact>
      <Fact id="perf" title={i18n.tn("contentsPerf")} status={perf.status}>
        {perf.status === "none"
          ? i18n.tn("perfNone")
          : i18n.tn("perfSummary", {
              vitals: n(perf.vitals),
              longTasks: n(perf.longTasks),
              traces: n(perf.traces)
            })}
      </Fact>
    </ul>
  );
}

type SessionFactsProps = { archive: LoadedArchive; contents: ArchiveContents };

function SessionFacts({ archive, contents }: SessionFactsProps) {
  const i18n = useI18n();
  const locale = usePlayerState((state) => state.locale);
  const { meta } = archive.view;
  const rows: [NextMessageKey, string][] = [
    ["factOrigin", meta.origin],
    ["factTitle", meta.title ?? ""],
    ["factRecorded", formatRecordedAt(meta.createdAt, locale)],
    ["factDuration", i18n.formatSeconds(meta.durationMs)],
    ["factCapture", i18n.formatMode(meta.mode)],
    ["factProfile", contents.profiles.map((entry) => entry.name).join(" → ")],
    ["factEvents", i18n.formatNumber(meta.eventCount)],
    ["factOtherTabs", meta.otherTabs > 0 ? i18n.formatNumber(meta.otherTabs) : ""],
    ["factFile", `${archive.fileName} · ${i18n.formatByteSize(archive.bytes.byteLength)}`],
    ["factEncryption", i18n.tn(meta.encrypted ? "encryptionOn" : "encryptionOff")]
  ];

  return (
    <dl className="facts-kv" data-testid="session-facts">
      {rows
        .filter(([, value]) => value)
        .map(([key, value]) => (
          <div key={key} className="facts-kv-row">
            <dt>{i18n.tn(key)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

/**
 * "About this recording" (PROPOSAL §10, Bench's Summary panel): the session facts, the profile
 * warnings and what each kind of data holds, including what older archives could not keep.
 */
export function ArchiveInfoDialog() {
  const controller = useController();
  const i18n = useI18n();
  const open = usePlayerState((state) => state.archiveInfoOpen);
  const archive = usePlayerState((state) => state.archive);
  const contents = useMemo(() => (archive ? archiveContentsOf(archive) : null), [archive]);
  const banners = useMemo(
    () => (archive ? profileBannerLines(archive, i18n) : []),
    [archive, i18n]
  );

  return (
    <ModalDialog
      open={open && archive !== null}
      onClose={() => controller.setArchiveInfoOpen(false)}
      className="dlg-wide"
      testId="archive-info"
    >
      {archive && contents ? (
        <div className="dlg-body archive-info">
          <DialogTitle>{i18n.tn("aboutRecording")}</DialogTitle>
          {!contents.playable ? (
            <p className="notice bad" data-testid="no-playback-events">
              <Icon name="error" />
              {i18n.tn("noPlaybackEvents")}
            </p>
          ) : null}
          {banners.map((line) => (
            <p key={line} className="notice warn" data-testid="profile-banner-line">
              <Icon name="flag" />
              {line}
            </p>
          ))}
          <h3>{i18n.tn("sessionSection")}</h3>
          <SessionFacts archive={archive} contents={contents} />
          <h3>{i18n.tn("contentsSection")}</h3>
          <ContentsList contents={contents} />
          <div className="dlg-actions">
            <button
              type="button"
              className="btn primary"
              onClick={() => controller.setArchiveInfoOpen(false)}
              data-testid="archive-info-close"
            >
              {i18n.tn("close")}
            </button>
          </div>
        </div>
      ) : null}
    </ModalDialog>
  );
}

/**
 * The recording profile warnings (downgraded, capped by policy, recording cut short) above the
 * stage, with a way to the full "About this recording". Nothing for a recording that kept
 * everything its profile asks for.
 */
export function ProfileBanners() {
  const controller = useController();
  const i18n = useI18n();
  const archive = usePlayerState((state) => state.archive);
  const lines = useMemo(() => (archive ? profileBannerLines(archive, i18n) : []), [archive, i18n]);

  if (lines.length === 0) {
    return null;
  }

  return (
    <section
      className="profile-banners"
      aria-label={i18n.tn("profileBannersLabel")}
      data-testid="profile-banners"
    >
      {lines.map((line) => (
        <p key={line} className="profile-banner" data-testid="profile-banner">
          <Icon name="flag" />
          <span>{line}</span>
        </p>
      ))}
      <button
        type="button"
        className="btn small"
        onClick={() => controller.setArchiveInfoOpen(true)}
        data-testid="profile-banner-details"
      >
        {i18n.tn("profileDetails")}
      </button>
    </section>
  );
}
