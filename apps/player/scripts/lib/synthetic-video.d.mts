import type { SyntheticSession } from "./synthetic-session.mjs";

export type SyntheticVideoSegment = {
  chunks: Uint8Array[];
  startOffsetMs: number;
  durationMs: number;
  mime?: string;
  width?: number;
  height?: number;
};

export declare function withTabVideo(
  session: SyntheticSession,
  segments: SyntheticVideoSegment[]
): SyntheticSession;
