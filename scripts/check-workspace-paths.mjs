#!/usr/bin/env node

// Keeps tsconfig `paths` in step with the package.json `exports` maps (see
// config/workspace-sources.mjs). A missing or stale entry would make typecheck fall back to a
// sibling's built `dist/` types, so source changes would silently go unchecked.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { listWorkspaceSources } from "../config/workspace-sources.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_DIRS = ["apps", "packages"];
const SOURCE_FILE_PATTERN = /\.(ts|tsx)$/;
const IMPORT_SPECIFIER_PATTERN = /(?:from|import)\s*\(?\s*"([^"]+)"/g;

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function main() {
  const sources = listWorkspaceSources();
  const sourceBySpecifier = new Map(sources.map((source) => [source.specifier, source]));
  const packageNames = new Set(sources.map((source) => source.packageName));
  const failures = listProjectDirs().flatMap((projectDir) =>
    checkProject(projectDir, sourceBySpecifier, packageNames)
  );

  if (failures.length > 0) {
    throw new Error(`Workspace path check failed:\n${failures.map((f) => `- ${f}`).join("\n")}`);
  }

  console.log(`Workspace paths match package exports (${sources.length} entries).`);
}

function listProjectDirs() {
  return WORKSPACE_DIRS.flatMap((dir) =>
    readdirSync(join(root, dir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, dir, entry.name))
      .filter((projectDir) => existsSync(join(projectDir, "tsconfig.json")))
  );
}

function checkProject(projectDir, sourceBySpecifier, packageNames) {
  const label = relative(root, projectDir);
  const ownName = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")).name;
  const tsconfig = JSON.parse(readFileSync(join(projectDir, "tsconfig.json"), "utf8"));
  const options = tsconfig.compilerOptions ?? {};
  const baseDir = resolve(projectDir, options.baseUrl ?? ".");
  const paths = options.paths ?? {};
  const failures = [];

  for (const [specifier, targets] of Object.entries(paths)) {
    if (!packageNames.has(toPackageName(specifier))) {
      continue;
    }

    const expected = sourceBySpecifier.get(specifier);
    const actual =
      Array.isArray(targets) && targets.length === 1 ? resolve(baseDir, targets[0]) : "";

    if (!expected) {
      failures.push(`${label}: tsconfig path '${specifier}' is not a package export.`);
    } else if (actual !== expected.file) {
      failures.push(
        `${label}: tsconfig path '${specifier}' should be ['${relative(baseDir, expected.file)}'].`
      );
    }
  }

  for (const specifier of collectWorkspaceImports(join(projectDir, "src"), packageNames)) {
    if (toPackageName(specifier) !== ownName && !(specifier in paths)) {
      failures.push(`${label}: imports '${specifier}' but tsconfig has no 'paths' entry for it.`);
    }
  }

  return failures;
}

function collectWorkspaceImports(srcDir, packageNames) {
  const specifiers = new Set();

  for (const file of listSourceFiles(srcDir)) {
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT_SPECIFIER_PATTERN)) {
      const specifier = match[1];

      if (packageNames.has(toPackageName(specifier))) {
        specifiers.add(specifier);
      }
    }
  }

  return [...specifiers].sort();
}

function listSourceFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      return listSourceFiles(path);
    }

    return SOURCE_FILE_PATTERN.test(entry.name) ? [path] : [];
  });
}

function toPackageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
}
