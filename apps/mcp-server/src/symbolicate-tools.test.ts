import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import type { ExportManifest, WebBlackboxEvent } from "@webblackbox/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { symbolicateArchiveStacks } from "./symbolicate-tools.js";

const SCRIPT = "https://app.test/assets/app.min.js";
// Generated 1:1 → src/cart.ts 3:5 (name "boom").
const MAP = JSON.stringify({
  version: 3,
  sources: ["../src/cart.ts"],
  sourcesContent: ["// cart\nconst x = 1;\nfunction boom() {}\n"],
  names: ["boom"],
  mappings: "AAEIA"
});

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("symbolicateArchiveStacks", () => {
  it("maps the archive's error events through .map files in mapsDir", async () => {
    const { archivePath, mapsDir } = await createFixture();
    const result = await symbolicateArchiveStacks({ path: archivePath, mapsDir });

    expect(result.mapFiles).toBe(1);
    expect(result.stacks).toHaveLength(1);
    expect(result.stacks[0]).toMatchObject({
      eventId: "E-2",
      type: "error.exception",
      message: "boom"
    });
    expect(result.stacks[0]?.frames[0]).toMatchObject({
      status: "mapped",
      mapSource: "files",
      original: { line: 3, column: 5 }
    });
    expect(result.stacks[0]?.frames[0]?.original?.source).toMatch(/src\/cart\.ts$/u);
    expect(result.stacks[0]?.frames[0]?.snippet?.lines).toContain("function boom() {}");
  });

  it("symbolicates a pasted stack and reports frames without maps", async () => {
    const { archivePath, mapsDir } = await createFixture();
    const result = await symbolicateArchiveStacks({
      path: archivePath,
      mapsDir,
      stack: `Error: x\n    at a (${SCRIPT}:1:1)\n    at b (https://other.test/b.js:1:1)`
    });

    expect(result.stacks[0]?.frames.map((frame) => frame.status)).toEqual(["mapped", "no-map"]);
  });

  it("selects one event by id and rejects unknown ids", async () => {
    const { archivePath } = await createFixture();

    expect(
      (await symbolicateArchiveStacks({ path: archivePath, eventId: "E-2" })).stacks[0]?.frames[0]
        ?.status
    ).toBe("no-map");
    await expect(symbolicateArchiveStacks({ path: archivePath, eventId: "nope" })).rejects.toThrow(
      /not found/u
    );
  });

  it("does not follow symbolic links out of mapsDir", async () => {
    const { archivePath, root } = await createFixture();
    const outside = join(root, "outside");
    const mapsDir = join(root, "linked-maps");

    await mkdir(outside, { recursive: true });
    await mkdir(mapsDir, { recursive: true });
    await writeFile(join(outside, "app.min.js.map"), MAP);
    await symlink(join(outside, "app.min.js.map"), join(mapsDir, "app.min.js.map"));
    await symlink(outside, join(mapsDir, "outside-dir"));

    const result = await symbolicateArchiveStacks({ path: archivePath, mapsDir });

    expect(result.mapFiles).toBe(0);
    expect(result.stacks[0]?.frames[0]?.status).toBe("no-map");
  });
});

async function createFixture(): Promise<{ root: string; archivePath: string; mapsDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "wb-mcp-symbolicate-"));
  const mapsDir = join(root, "maps");
  const archivePath = join(root, "session.webblackbox");

  tempDirs.push(root);
  await mkdir(join(mapsDir, "dist"), { recursive: true });
  await writeFile(join(mapsDir, "dist", "app.min.js.map"), MAP);
  await writeFile(join(mapsDir, "dist", "notes.txt"), "not a map");
  await writeFile(
    archivePath,
    await createArchive([
      event("E-1", "console.entry", { level: "log", text: "hello" }),
      event("E-2", "error.exception", {
        message: "boom",
        stack: `Error: boom\n    at b (${SCRIPT}?v=2:1:1)`
      })
    ])
  );

  return { root, archivePath, mapsDir };
}

function event(id: string, type: WebBlackboxEvent["type"], data: unknown): WebBlackboxEvent {
  return { v: 1, sid: "S-1", tab: 1, t: 1_000, mono: Number(id.slice(2)), type, id, data };
}

async function createArchive(events: WebBlackboxEvent[]): Promise<Uint8Array> {
  const zip = new JSZip();
  const files = new Map<string, string>();
  const add = (path: string, content: string) => {
    zip.file(path, content);
    files.set(path, content);
  };
  const manifest: ExportManifest = {
    protocolVersion: 1,
    createdAt: new Date(0).toISOString(),
    mode: "full",
    site: { origin: "https://app.test", title: "Symbolicate fixture" },
    chunkCodec: "none",
    redactionProfile: {
      redactHeaders: [],
      redactCookieNames: [],
      redactBodyPatterns: [],
      blockedSelectors: [],
      hashSensitiveValues: true
    },
    stats: { eventCount: events.length, chunkCount: 1, blobCount: 0, durationMs: 1 }
  };

  add("manifest.json", JSON.stringify(manifest));
  add("index/time.json", "[]");
  add("index/req.json", "[]");
  add("index/inv.json", "[]");
  add("events/chunk-000001.ndjson", events.map((entry) => JSON.stringify(entry)).join("\n"));

  const hashes = Object.fromEntries(
    [...files.entries()].map(([path, content]) => [
      path,
      createHash("sha256").update(content).digest("hex")
    ])
  );

  zip.file(
    "integrity/hashes.json",
    JSON.stringify({ manifestSha256: hashes["manifest.json"], files: hashes })
  );

  return zip.generateAsync({ type: "uint8array" });
}
