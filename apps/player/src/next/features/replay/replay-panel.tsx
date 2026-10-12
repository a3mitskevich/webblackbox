import "./replay.css";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { formatOffset } from "../../../core/format.js";
import {
  DOM_REPLAY_FRAME_PATH,
  parseFrameToPlayerMessage,
  replayTargetOrigin,
  type DomReplayResource,
  type FrameToPlayerMessage,
  type PlayerToFrameMessage
} from "../../../lib/dom-replay-protocol.js";
import { useController, usePlayerState } from "../../context.js";
import type { LoadedArchive } from "../../state.js";
import { useFeatureI18n } from "../messages.js";
import { replayMessages, type ReplayTranslate } from "./messages.js";
import {
  buildRrwebTimeline,
  clickAt,
  selectReplayResources,
  timestampAtMono,
  type RrwebTimeline
} from "./replay-model.js";

/** While playing, the frame follows the playhead in steps of this size. */
const SEEK_BUCKET_MS = 250;
const MAX_CLICK_ROWS = 200;

type FrameStatus =
  | { phase: "loading" }
  | { phase: "loaded"; message: Extract<FrameToPlayerMessage, { type: "wb-replay/loaded" }> }
  | { phase: "error"; message: string };

type Highlight = Extract<FrameToPlayerMessage, { type: "wb-replay/highlight" }>;

/** One key per opened archive: a new archive gets a fresh frame instead of the last replay. */
const archiveKeys = new WeakMap<LoadedArchive, number>();
let openedArchives = 0;

function keyOf(archive: LoadedArchive): number {
  const known = archiveKeys.get(archive);

  if (known !== undefined) {
    return known;
  }

  openedArchives += 1;
  archiveKeys.set(archive, openedArchives);
  return openedArchives;
}

async function loadResources(archive: LoadedArchive): Promise<DomReplayResource[]> {
  const refs = selectReplayResources(archive.player.getNetworkWaterfall());
  const loaded = await Promise.all(
    refs.map(async (ref) => {
      try {
        const blob = await archive.player.getBlob(ref.hash);
        return blob
          ? [
              {
                url: ref.url,
                mime: ref.mime,
                blob: new Blob([blob.bytes.slice()], { type: ref.mime })
              }
            ]
          : [];
      } catch {
        return [];
      }
    })
  );

  return loaded.flat();
}

/** The archive's rrweb log in the sandboxed replay frame, following the playhead. */
export default function ReplayPanel() {
  const t = useFeatureI18n(replayMessages);
  const archive = usePlayerState((state) => state.archive);
  const timeline = useMemo(
    () =>
      archive ? buildRrwebTimeline(archive.player.query({ types: ["dom.rrweb.event"] })) : null,
    [archive]
  );

  if (!archive || !timeline) {
    return (
      <p className="rp-note" data-testid="replay-empty">
        {t("empty")}
      </p>
    );
  }

  return <ReplayView key={keyOf(archive)} archive={archive} timeline={timeline} t={t} />;
}

function ReplayView({
  archive,
  timeline,
  t
}: {
  archive: LoadedArchive;
  timeline: RrwebTimeline;
  t: ReplayTranslate;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<FrameStatus>({ phase: "loading" });
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const [seekMs, setSeekMs] = useState<number | null>(null);
  const playheadMono = usePlayerState((state) =>
    state.isPlaying
      ? Math.floor(state.playheadMono / SEEK_BUCKET_MS) * SEEK_BUCKET_MS
      : state.playheadMono
  );

  // Replies count only from the frame's window on this origin, and are validated.
  const post = useCallback((message: PlayerToFrameMessage) => {
    frameRef.current?.contentWindow?.postMessage(
      message,
      replayTargetOrigin(window.location.origin)
    );
  }, []);

  useEffect(() => {
    let disposed = false;
    const onMessage = (event: MessageEvent) => {
      if (
        event.source === null ||
        event.source !== frameRef.current?.contentWindow ||
        event.origin !== window.location.origin
      ) {
        return;
      }

      const message = parseFrameToPlayerMessage(event.data);

      switch (message?.type) {
        case "wb-replay/ready":
          void loadResources(archive).then((resources) => {
            if (!disposed) {
              post({ type: "wb-replay/load", events: timeline.events, resources });
            }
          });
          break;
        case "wb-replay/loaded":
          setStatus({ phase: "loaded", message });
          break;
        case "wb-replay/highlight":
          setHighlight(message);
          break;
        case "wb-replay/seeked":
          setSeekMs(message.durationMs);
          break;
        case "wb-replay/error":
          setStatus({ phase: "error", message: message.message });
          break;
        default:
          break;
      }
    };

    window.addEventListener("message", onMessage);
    return () => {
      disposed = true;
      window.removeEventListener("message", onMessage);
    };
  }, [archive, timeline, post]);

  const isLoaded = status.phase === "loaded";
  const timestamp = timestampAtMono(timeline, playheadMono);
  const activeClick = clickAt(timeline, timestamp);

  useEffect(() => {
    if (!isLoaded) {
      return;
    }

    post({
      type: "wb-replay/seek",
      timestamp,
      highlightNodeId: activeClick?.nodeId ?? null
    });

    if (!activeClick) {
      setHighlight(null);
    }
  }, [isLoaded, timestamp, activeClick, post]);

  return (
    <div className="rp-panel" data-testid="replay-panel">
      <p className="rp-note">{t("spikeNote")}</p>
      <StatusNote status={status} timeline={timeline} seekMs={seekMs} t={t} />
      <HighlightNote highlight={activeClick ? highlight : null} t={t} />
      <div className="rp-stage">
        <iframe
          ref={frameRef}
          className="rp-frame"
          src={DOM_REPLAY_FRAME_PATH}
          // Same origin on purpose: rrweb rebuilds the page in a nested `allow-same-origin`
          // iframe, which an opaque-origin parent could not reach. The recorded page still runs
          // no scripts (that nested sandbox has no allow-scripts, and the frame's CSP allows
          // only its own script file); the sandbox adds no popups, forms or top navigation.
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="no-referrer"
          title={t("frameTitle")}
          data-testid="replay-frame"
        />
      </div>
      <ClickList
        archive={archive}
        timeline={timeline}
        activeTimestamp={activeClick?.timestamp}
        t={t}
      />
    </div>
  );
}

function StatusNote({
  status,
  timeline,
  seekMs,
  t
}: {
  status: FrameStatus;
  timeline: RrwebTimeline;
  seekMs: number | null;
  t: ReplayTranslate;
}) {
  if (status.phase === "error") {
    return (
      <p className="rp-note bad" data-testid="replay-error">
        {t("error", { message: status.message })}
      </p>
    );
  }

  if (status.phase === "loading") {
    return <p className="rp-note">{t("loading")}</p>;
  }

  const { eventCount, resolvedResources, unresolvedUrls } = status.message;

  return (
    <>
      <p
        className="rp-note"
        data-testid="replay-status"
        data-events={eventCount}
        data-seek-ms={seekMs ?? ""}
      >
        {t("loaded", {
          events: eventCount,
          snapshots: timeline.fullSnapshots,
          resources: resolvedResources
        })}
      </p>
      {unresolvedUrls.length > 0 ? (
        <p className="rp-note" title={unresolvedUrls.join("\n")}>
          {t("unresolved", { count: unresolvedUrls.length })}
        </p>
      ) : null}
      {timeline.otherTabs.length > 0 ? (
        <p className="rp-note">
          {t("otherTabs", { tab: timeline.tab, tabs: timeline.otherTabs.join(", ") })}
        </p>
      ) : null}
    </>
  );
}

function HighlightNote({ highlight, t }: { highlight: Highlight | null; t: ReplayTranslate }) {
  if (!highlight) {
    return null;
  }

  if (!highlight.found || !highlight.rect) {
    return (
      <p className="rp-note bad" data-testid="replay-highlight" data-found="false">
        {t("highlightMissing", { node: highlight.nodeId })}
      </p>
    );
  }

  const { x, y, width, height } = highlight.rect;

  return (
    <p className="rp-note" data-testid="replay-highlight" data-found="true">
      {t("highlightFound", {
        tag: (highlight.tagName ?? "?").toLowerCase(),
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height)
      })}
    </p>
  );
}

function ClickList({
  archive,
  timeline,
  activeTimestamp,
  t
}: {
  archive: LoadedArchive;
  timeline: RrwebTimeline;
  activeTimestamp: number | undefined;
  t: ReplayTranslate;
}) {
  const controller = useController();
  const locale = usePlayerState((state) => state.locale);
  const clicks = timeline.clicks.slice(0, MAX_CLICK_ROWS);

  return (
    <section className="rp-clicks" aria-label={t("clicks")}>
      <h3>{t("clicks")}</h3>
      {clicks.length === 0 ? <p className="rp-note">{t("noClicks")}</p> : null}
      <ul className="rp-clicks-list">
        {clicks.map((click) => (
          <li key={`${click.timestamp}:${click.nodeId}`}>
            <button
              type="button"
              className="rp-click"
              data-testid="replay-click"
              aria-current={click.timestamp === activeTimestamp}
              onClick={() => controller.seek(click.mono)}
            >
              {t("clickRow", {
                node: click.nodeId,
                time: formatOffset(click.mono - archive.model.minMono, locale)
              })}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
