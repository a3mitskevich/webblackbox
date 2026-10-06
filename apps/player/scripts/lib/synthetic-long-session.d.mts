import type { SyntheticSession } from "./synthetic-session.mjs";

export declare const LONG_SESSION_ORIGIN: string;
export declare const LONG_SESSION_DEFAULTS: Readonly<{
  durationMs: number;
  events: number;
  seed: number;
}>;

export type LongSessionOptions = {
  durationMs?: number;
  events?: number;
  seed?: number;
};

export declare function buildLongSyntheticSession(options?: LongSessionOptions): SyntheticSession;
export declare function createLongPlainArchive(session?: SyntheticSession): Promise<Uint8Array>;
