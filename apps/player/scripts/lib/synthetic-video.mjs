// Adds tab video segments (screen.recording.start / chunk / end + chunk blobs) to a synthetic
// session, as the extension records them: chunks stored in index order with a 1 s timeslice.
import { sha256Hex, SYNTHETIC_SESSION_ID } from "./synthetic-session.mjs";

const VIDEO_MIME = "video/webm;codecs=vp9";

/**
 * @param {import("./synthetic-session.mjs").SyntheticSession} session
 * @param {Array<{ chunks: Uint8Array[]; startOffsetMs: number; durationMs: number; mime?: string; width?: number; height?: number }>} segments
 */
export function withTabVideo(session, segments) {
  const first = session.events[0];
  const events = [...session.events];
  const blobs = [...session.blobs];
  let sequence = 0;

  const add = (mono, type, data) => {
    sequence += 1;
    events.push({
      v: 1,
      sid: first.sid,
      tab: first.tab,
      t: first.t + (mono - first.mono),
      mono,
      type,
      id: `E-video-${String(sequence).padStart(4, "0")}`,
      data
    });
  };

  segments.forEach((segment, position) => {
    const recordingId = `VR-${SYNTHETIC_SESSION_ID}-${position + 1}`;
    const mime = segment.mime ?? VIDEO_MIME;
    const startMono = first.mono + segment.startOffsetMs;
    const size = segment.chunks.reduce((total, bytes) => total + bytes.length, 0);
    const step = segment.durationMs / segment.chunks.length;
    const hashes = segment.chunks.map((bytes) => {
      const hash = sha256Hex(bytes);

      if (!blobs.some((blob) => blob.hash === hash)) {
        blobs.push({ hash, mime: "video/webm", bytes });
      }

      return hash;
    });
    const dimensions = {
      ...(segment.width ? { width: segment.width } : {}),
      ...(segment.height ? { height: segment.height } : {})
    };

    add(startMono, "screen.recording.start", { recordingId, source: "tab", mime, ...dimensions });
    segment.chunks.forEach((bytes, index) =>
      add(Math.round(startMono + (index + 1) * step), "screen.recording.chunk", {
        recordingId,
        chunkId: hashes[index],
        index,
        mime,
        size: bytes.length
      })
    );
    add(startMono + segment.durationMs + 1, "screen.recording.end", {
      recordingId,
      mime,
      chunks: hashes,
      chunkCount: hashes.length,
      size,
      durationMs: segment.durationMs,
      ...dimensions,
      reason: "session-stop"
    });
  });

  events.sort((left, right) => left.mono - right.mono || left.id.localeCompare(right.id));

  return {
    ...session,
    events,
    blobs,
    manifest: {
      ...session.manifest,
      stats: { ...session.manifest.stats, eventCount: events.length, blobCount: blobs.length }
    }
  };
}
