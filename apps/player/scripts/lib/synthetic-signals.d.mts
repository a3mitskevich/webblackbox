import type { SyntheticSession } from "./synthetic-session.mjs";

export declare const AUTH_ERROR_STACK: string;
export declare function buildMainScriptSourceMap(): string;
export declare function addR4Signals(helpers: unknown): void;
export declare function buildCompareVariant(
  session: SyntheticSession,
  sha256Hex: (bytes: Uint8Array) => string
): SyntheticSession;
