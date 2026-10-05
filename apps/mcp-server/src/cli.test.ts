import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { formatCliHelp, isDirectCliInvocation, parseCliArgs } from "./cli.js";

describe("mcp-server cli", () => {
  it("parses help and version flags", () => {
    expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["-v"])).toEqual({ kind: "version" });
    expect(parseCliArgs(["--stdio"])).toEqual({ kind: "start", allowedDirs: [] });
  });

  it("collects repeated --allow-dir values", () => {
    expect(parseCliArgs(["--allow-dir", "./archives", "--allow-dir=/data/sessions"])).toEqual({
      kind: "start",
      allowedDirs: ["./archives", "/data/sessions"]
    });
    expect(() => parseCliArgs(["--allow-dir"])).toThrow("--allow-dir requires a directory path");
    expect(() => parseCliArgs(["--allow-dir="])).toThrow("--allow-dir requires a directory path");
  });

  it("prints usage text", () => {
    expect(formatCliHelp()).toContain("webblackbox-mcp-server");
    expect(formatCliHelp()).toContain("--version");
    expect(formatCliHelp()).toContain("--allow-dir <dir>");
  });

  it("rejects unknown arguments", () => {
    expect(() => parseCliArgs(["--wat"])).toThrow("Unknown argument");
  });

  it("detects symlinked direct cli invocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "wb-mcp-cli-"));
    const actual = join(root, "cli.js");
    const linked = join(root, "bin.js");

    await writeFile(actual, "console.log('ok');\n", "utf8");
    await symlink(actual, linked);

    expect(isDirectCliInvocation(linked, pathToFileURL(actual).href)).toBe(true);
  });
});
