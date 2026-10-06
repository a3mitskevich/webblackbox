import type { ExportManifest, WebBlackboxEvent } from "@webblackbox/protocol";

export declare const SYNTHETIC_ORIGIN: string;
export declare const SYNTHETIC_PASSPHRASE: string;
export declare const SYNTHETIC_SESSION_ID: string;
export declare const SYNTHETIC_DURATION_MS: number;

export type SyntheticBlob = {
  hash: string;
  mime: string;
  bytes: Uint8Array;
};

export type SyntheticSession = {
  events: WebBlackboxEvent[];
  blobs: SyntheticBlob[];
  manifest: ExportManifest;
};

export declare function sha256Hex(bytes: Uint8Array): string;
export declare function buildSyntheticSession(): SyntheticSession;
export declare function encodeEventChunk(events: WebBlackboxEvent[]): Uint8Array;
export declare function createPlainArchive(session?: SyntheticSession): Promise<Uint8Array>;
export declare function buildArchiveIndexes(
  session: SyntheticSession,
  chunkBytes: Uint8Array
): {
  timeIndex: unknown[];
  requestIndex: { reqId: string; eventIds: string[] }[];
  invertedIndex: unknown[];
};
