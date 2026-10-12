import type { UserManifest } from "wxt";

export type ExtensionProfile = "dev" | "store-safe";

export declare const EXTENSION_MANIFEST_PROFILES: readonly ExtensionProfile[];

export declare const CLASSIC_SCRIPT_FILES: readonly string[];

export declare function profileForMode(mode: string): ExtensionProfile;

export declare function createManifestFields(options?: {
  profile?: string;
  command?: string;
}): UserManifest;

export declare function validateExtensionManifest(
  manifest: Record<string, unknown>,
  options?: { profile?: string }
): string[];

export declare function assertExtensionBuild(
  outputDir: string,
  options?: { profile?: string }
): Promise<Record<string, unknown>>;

export declare function isStrictScopedScript(code: string): boolean;
