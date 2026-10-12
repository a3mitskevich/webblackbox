import type { UserManifest } from "wxt";

export type BuildTarget = { profile: string; release: boolean };

export declare const appRoot: string;

export declare const buildDir: string;

export declare const CLASSIC_SCRIPT_CHUNKS: readonly string[];

export declare function readBuildTarget(env: Record<string, string | undefined>): BuildTarget;

export declare function createManifestFields(target?: Partial<BuildTarget>): UserManifest;

export declare function normalizeWxtManifest(manifest: object, target: Partial<BuildTarget>): void;

export declare function declaresTopLevelBindings(code: string): boolean;

export declare function assertExtensionBuild(
  outputDir: string,
  options?: Partial<BuildTarget> & { version?: string }
): Promise<Record<string, unknown>>;
