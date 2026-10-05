import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createArchivePathGuard } from "./path-guard.js";

async function createLayout(): Promise<{ root: string; allowed: string; outside: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wb-mcp-guard-")));
  const allowed = join(root, "archives");
  const outside = join(root, "archives-private");

  await mkdir(allowed);
  await mkdir(outside);
  await writeFile(join(allowed, "session.webblackbox"), "zip");
  await writeFile(join(outside, "secret.webblackbox"), "zip");

  return { root, allowed, outside };
}

describe("createArchivePathGuard", () => {
  it("resolves any path against cwd when no directories are allowed", async () => {
    const guard = createArchivePathGuard([], "/work");

    await expect(guard("a/b.webblackbox")).resolves.toBe("/work/a/b.webblackbox");
    await expect(guard("/etc/passwd")).resolves.toBe("/etc/passwd");
  });

  it("accepts paths inside an allowed directory", async () => {
    const { root, allowed } = await createLayout();
    const guard = createArchivePathGuard(["archives"], root);

    await expect(guard("archives/session.webblackbox")).resolves.toBe(
      join(allowed, "session.webblackbox")
    );
    await expect(guard("archives")).resolves.toBe(allowed);
  });

  it("rejects traversal and sibling directories that share a prefix", async () => {
    const { root, allowed } = await createLayout();
    const guard = createArchivePathGuard([allowed], root);

    await expect(guard("archives/../archives-private/secret.webblackbox")).rejects.toThrow(
      "outside the allowed directories"
    );
    await expect(guard(join(root, "archives-private"))).rejects.toThrow(
      "outside the allowed directories"
    );
    await expect(guard("/etc/passwd")).rejects.toThrow("outside the allowed directories");
  });

  it("rejects symlinks inside an allowed directory that point outside it", async () => {
    const { root, allowed, outside } = await createLayout();
    await symlink(join(outside, "secret.webblackbox"), join(allowed, "link.webblackbox"));
    const guard = createArchivePathGuard([allowed], root);

    await expect(guard("archives/link.webblackbox")).rejects.toThrow(
      "outside the allowed directories"
    );
  });
});
