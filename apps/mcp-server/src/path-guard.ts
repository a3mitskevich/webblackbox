import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Resolves a tool-supplied path, rejecting it when it falls outside the allowed directories. */
export type ArchivePathGuard = (pathLike: string) => Promise<string>;

/**
 * Creates a guard for archive and directory paths received from MCP clients.
 * With no allowed directories every path is accepted (resolved against `cwd`).
 * Otherwise the path must stay inside one of the allowed directories after
 * symlinks are resolved.
 */
export function createArchivePathGuard(
  allowedDirs: readonly string[],
  cwd: string = process.cwd()
): ArchivePathGuard {
  if (allowedDirs.length === 0) {
    return async (pathLike) => resolve(cwd, pathLike);
  }

  const lexicalRoots = allowedDirs.map((dir) => resolve(cwd, dir));
  const realRootsPromise = Promise.all(lexicalRoots.map((root) => realpathOrSelf(root)));

  return async (pathLike) => {
    const realRoots = await realRootsPromise;
    const target = resolve(cwd, pathLike);
    const outsideError = new Error(
      `Path '${pathLike}' is outside the allowed directories (--allow-dir).`
    );

    // Reject before touching the filesystem so outside paths do not leak existence.
    if (!isWithinAny([...lexicalRoots, ...realRoots], target)) {
      throw outsideError;
    }

    const realTarget = await realpath(target);

    if (!isWithinAny(realRoots, realTarget)) {
      throw outsideError;
    }

    return realTarget;
  };
}

function isWithinAny(roots: readonly string[], target: string): boolean {
  return roots.some((root) => isWithin(root, target));
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);

  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}
