// Maps every workspace package export (`@webblackbox/pipeline/storage`, `webblackbox/lite-sdk`, ...)
// to its TypeScript source, so tests resolve sibling packages from `src/` instead of a possibly
// stale `dist/`. The package.json `exports` map is the single source of truth: a new subpath only
// needs its export and tsup entry; vitest aliases follow automatically and
// `scripts/check-workspace-paths.mjs` verifies the tsconfig `paths`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");
const DIST_ENTRY_PATTERN = /^\.\/dist\/(.+)\.js$/;

/**
 * @typedef {{ specifier: string; packageName: string; file: string }} WorkspaceSource
 */

/** @returns {WorkspaceSource[]} */
export function listWorkspaceSources() {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(PACKAGES_DIR, entry.name))
    .filter((packageDir) => existsSync(join(packageDir, "package.json")))
    .flatMap((packageDir) => listPackageSources(packageDir));
}

/**
 * Vite/vitest `resolve.alias` entries. Exact-match regexes, so the bare `webblackbox` alias
 * cannot swallow `webblackbox/lite-sdk` the way a prefix-matching string key would.
 *
 * @returns {Array<{ find: RegExp; replacement: string }>}
 */
export function workspaceSourceAliases() {
  return listWorkspaceSources().map(({ specifier, file }) => ({
    find: new RegExp(`^${escapeRegExp(specifier)}$`),
    replacement: file
  }));
}

/**
 * @param {string} packageDir
 * @returns {WorkspaceSource[]}
 */
function listPackageSources(packageDir) {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const packageName = manifest.name;
  const exportsMap = manifest.exports ?? {};

  if (typeof packageName !== "string" || typeof exportsMap !== "object") {
    throw new Error(`Unexpected package.json shape in ${packageDir}.`);
  }

  return Object.entries(exportsMap).map(([subpath, target]) => {
    const entry = typeof target === "string" ? target : target?.import;
    const match = typeof entry === "string" ? DIST_ENTRY_PATTERN.exec(entry) : null;

    if (!match) {
      throw new Error(
        `${packageName} export '${subpath}' must point at ./dist/<name>.js to map to a source file.`
      );
    }

    const file = join(packageDir, "src", `${match[1]}.ts`);

    if (!existsSync(file)) {
      throw new Error(`${packageName} export '${subpath}' has no source file at ${file}.`);
    }

    return {
      specifier: subpath === "." ? packageName : `${packageName}/${subpath.slice(2)}`,
      packageName,
      file
    };
  });
}

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
