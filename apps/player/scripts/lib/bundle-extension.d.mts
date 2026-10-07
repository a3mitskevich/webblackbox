export declare const PLAYER_EXTENSION_DIR: string;
export declare const PLAYER_EXTENSION_ZIP: string;
export declare const PLAYER_EXTENSION_METADATA: string;

export type PackagedExtensionZip = {
  path: string;
  version: string;
  mtimeMs: number;
};

export declare function findPackagedExtensionZip(
  distDir: string,
  version: string
): Promise<string | PackagedExtensionZip | null>;

export type ExtensionBundleMetadata = {
  version: string;
  file: string;
  size: number;
  sha256: string;
  /** ISO 8601 UTC. */
  builtAt: string;
};

export type BundleExtensionResult =
  { bundled: true; metadata: ExtensionBundleMetadata } | { bundled: false; version: string };

export declare function bundleExtensionIntoPlayer(options: {
  extensionPackageJson: string;
  extensionDistDir: string;
  playerBuildDir: string;
  now?: () => Date;
}): Promise<BundleExtensionResult>;
