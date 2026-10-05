import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import type {
  ArchiveModel,
  ScreenRecordingRecord,
  ScreenshotRecord
} from "../../core/archive-model.js";
import { formatOffset } from "../../core/format.js";
import {
  buildScreenshotTrail,
  resolveScreenRecordingForMono,
  resolveScreenshotMarker,
  resolveShotForMono
} from "../../core/stage-media.js";
import {
  buildRippleMarks,
  RIPPLE_MAX_RADIUS,
  RIPPLE_MIN_RADIUS
} from "../../lib/pointer-overlay.js";
import { useController, useI18n, usePlayerState } from "../context.js";
import type { LoadedArchive } from "../state.js";

/** Video drift tolerated while playing / when paused before the element is re-seeked. */
const PLAYING_DRIFT_S = 0.35;
const PAUSED_DRIFT_S = 0.04;

type MediaState =
  | { kind: "none" }
  | { kind: "loading"; key: string }
  | { kind: "missing"; key: string }
  | { kind: "ready"; key: string; url: string };

type MediaSize = { width: number; height: number };

/** Loads an object URL for the current media key; stale loads are ignored. */
function useMediaUrl(key: string | null, load: () => Promise<string | null>): MediaState {
  const [state, setState] = useState<MediaState>({ kind: "none" });
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!key) {
      setState({ kind: "none" });
      return;
    }

    let cancelled = false;
    // Keep showing the previous frame while the next one loads (no flash between screenshots).
    setState((current) => (current.kind === "ready" ? current : { kind: "loading", key }));

    void loadRef.current().then(
      (url) => {
        if (!cancelled) {
          setState(url ? { kind: "ready", key, url } : { kind: "missing", key });
        }
      },
      () => {
        if (!cancelled) {
          setState({ kind: "missing", key });
        }
      }
    );

    return () => {
      cancelled = true;
    };
  }, [key]);

  return state;
}

function recordingOffsetSeconds(recording: ScreenRecordingRecord, playheadMono: number): number {
  const maxOffsetMs =
    recording.durationMs > 0
      ? recording.durationMs
      : Math.max(0, recording.endMono - recording.startMono);
  const offsetMs = Math.max(0, playheadMono - recording.startMono);
  return (maxOffsetMs > 0 ? Math.min(maxOffsetMs, offsetMs) : offsetMs) / 1_000;
}

type RecordingViewProps = {
  recording: ScreenRecordingRecord;
  url: string;
  playheadMono: number;
  isPlaying: boolean;
  rate: number;
  onSize: (size: MediaSize) => void;
};

/** The tab video, kept in step with the player clock (the clock is the master). */
function RecordingView({
  recording,
  url,
  playheadMono,
  isPlaying,
  rate,
  onSize
}: RecordingViewProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const i18n = useI18n();

  useEffect(() => {
    const video = ref.current;

    if (!video) {
      return;
    }

    const target = recordingOffsetSeconds(recording, playheadMono);
    const bounded =
      Number.isFinite(video.duration) && video.duration > 0
        ? Math.min(video.duration, target)
        : target;
    const drift = Math.abs(video.currentTime - bounded);

    video.playbackRate = rate;

    if (video.readyState >= 1 && drift > (isPlaying ? PLAYING_DRIFT_S : PAUSED_DRIFT_S)) {
      video.currentTime = bounded;
    }

    if (isPlaying && video.paused) {
      void video.play().catch(() => undefined);
    } else if (!isPlaying && !video.paused) {
      video.pause();
    }
  }, [recording, playheadMono, isPlaying, rate]);

  return (
    <video
      ref={ref}
      className="media"
      src={url}
      muted
      playsInline
      preload="metadata"
      aria-label={i18n.tn("stageTabVideo")}
      onLoadedMetadata={(event) =>
        onSize({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight })
      }
      data-testid="stage-video"
    />
  );
}

type PointerLayerProps = {
  model: ArchiveModel;
  playheadMono: number;
  shot: ScreenshotRecord | null;
  size: MediaSize;
};

/** Cursor, trail and click ripples in recorded viewport coordinates (SVG viewBox = viewport). */
function PointerLayer({ model, playheadMono, shot, size }: PointerLayerProps) {
  const trail = buildScreenshotTrail(model.pointers, playheadMono);
  const marker = resolveScreenshotMarker(model.pointers, playheadMono, shot?.marker ?? null);
  const ripples = buildRippleMarks(model.pointerActions, playheadMono);
  const sourceWidth = marker?.viewportWidth ?? shot?.context?.viewportWidth ?? size.width;
  const sourceHeight = marker?.viewportHeight ?? shot?.context?.viewportHeight ?? size.height;

  if (
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    (!marker && trail.length === 0 && ripples.length === 0)
  ) {
    return null;
  }

  return (
    <svg
      className="pointer-layer"
      viewBox={`0 0 ${sourceWidth} ${sourceHeight}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      data-testid="pointer-layer"
    >
      {trail.length > 1 ? (
        <polyline
          className="trail"
          points={trail.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ")}
        />
      ) : null}
      {ripples.map((mark) => {
        const radius = RIPPLE_MIN_RADIUS + (RIPPLE_MAX_RADIUS - RIPPLE_MIN_RADIUS) * mark.progress;
        return (
          <circle
            key={`${mark.mono}-${mark.kind}`}
            className={`ripple ripple-${mark.kind}`}
            cx={mark.x}
            cy={mark.y}
            r={radius}
            opacity={1 - mark.progress}
          />
        );
      })}
      {marker ? (
        <g
          className="cursor"
          transform={`translate(${marker.x} ${marker.y})`}
          data-testid="pointer-cursor"
        >
          <circle r="7" className="cursor-dot" />
          <path d="M 2 1 l 0 18 l 5 -5 l 4 9 l 4 -2 l -4 -8 l 7 0 z" className="cursor-arrow" />
        </g>
      ) : null}
    </svg>
  );
}

function currentRoute(archive: LoadedArchive, playheadMono: number): string {
  const chapter = [...archive.view.chapters]
    .reverse()
    .find((entry) => entry.startMono <= playheadMono);
  return chapter?.label ?? "";
}

export function Stage() {
  const controller = useController();
  const i18n = useI18n();
  const archive = usePlayerState((state) => state.archive);
  const playheadMono = usePlayerState((state) => state.playheadMono);
  const isPlaying = usePlayerState((state) => state.isPlaying);
  const rate = usePlayerState((state) => state.rate);
  const locale = usePlayerState((state) => state.locale);
  const [size, setSize] = useState<MediaSize>({ width: 0, height: 0 });
  const model = archive?.model ?? null;
  const recording = model
    ? resolveScreenRecordingForMono(model.screenRecordings, playheadMono)
    : null;
  const shot = model && !recording ? resolveShotForMono(model.screenshots, playheadMono) : null;
  const mediaKey = recording ? `rec:${recording.recordingId}` : shot ? `shot:${shot.shotId}` : null;
  const media = useMediaUrl(mediaKey, () =>
    recording
      ? controller.loadRecordingUrl(recording)
      : shot
        ? controller.loadScreenshotUrl(shot.shotId)
        : Promise.resolve(null)
  );
  const origin = archive?.view.meta.origin ?? "";
  const route = useMemo(
    () => (archive ? currentRoute(archive, playheadMono) : ""),
    [archive, playheadMono]
  );

  if (!archive || !model) {
    return null;
  }

  // A ready frame of the same media kind stays up until its successor has loaded.
  const ready =
    media.kind === "ready" && mediaKey !== null && media.key.slice(0, 4) === mediaKey.slice(0, 4);
  // The frame keeps the media aspect ratio inside the theater (see .frame in styles/next.css).
  const frameStyle = {
    "--ar": size.width > 0 && size.height > 0 ? (size.width / size.height).toFixed(4) : "1.7778"
  } as CSSProperties;
  const mediaLabel = recording ? i18n.tn("stageTabVideo") : shot ? i18n.tn("stageScreenshot") : "";
  const placeholder =
    media.kind === "loading"
      ? i18n.tn("stageLoading")
      : media.kind === "missing"
        ? i18n.tn("stageMissing")
        : i18n.tn("stageNoMedia");

  return (
    <div
      className="theater"
      data-testid="stage"
      data-media={ready ? (recording ? "video" : "screenshot") : "none"}
    >
      <div className="url-pill" title={`${origin}${route}`}>
        <span className="dot" aria-hidden="true" />
        <span className="url-text">
          {hostOf(origin)}
          {route.startsWith("#") || route.startsWith("/") ? route : ""}
        </span>
      </div>
      {mediaLabel && size.width > 0 ? (
        <div className="stage-meta">
          {mediaLabel} · {size.width}×{size.height}
        </div>
      ) : null}
      {ready ? (
        <div
          className="frame"
          style={frameStyle}
          onClick={() => controller.togglePlay()}
          data-testid="stage-frame"
        >
          {recording ? (
            <RecordingView
              recording={recording}
              url={media.url}
              playheadMono={playheadMono}
              isPlaying={isPlaying}
              rate={rate}
              onSize={setSize}
            />
          ) : (
            <img
              className="media"
              src={media.url}
              alt={i18n.tn("stageImageAlt", {
                time: formatOffset(playheadMono - model.minMono, locale)
              })}
              onLoad={(event) =>
                setSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight
                })
              }
              data-testid="stage-image"
            />
          )}
          <PointerLayer model={model} playheadMono={playheadMono} shot={shot} size={size} />
        </div>
      ) : (
        <p className="stage-placeholder" data-testid="stage-placeholder">
          {placeholder}
        </p>
      )}
    </div>
  );
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}
