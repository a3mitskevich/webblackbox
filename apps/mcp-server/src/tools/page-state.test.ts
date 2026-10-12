import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import type { DomA11ySnapshotData, ExportManifest, WebBlackboxEvent } from "@webblackbox/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { openArchivePlayer } from "../session-tools.js";
import { findOnPageInArchive, getPageStateAt, splitBudget } from "./page-state.js";
import type { ArchiveHandle } from "./registry.js";

const FORM = '- textbox "Card" [required]\n- button "Pay"';
const DECLINED = `${FORM}\n- alert: "Card declined"`;
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("page_state_at", () => {
  it("returns the snapshot an error triggered with the state before it", async () => {
    const path = await createFixture();
    const result = await getPageStateAt({ eventId: "E-3" }, archiveAt(path));

    expect(result.anchor).toMatchObject({ eventId: "E-3", eventType: "error.exception" });
    expect(result.linked).toMatchObject({
      eventId: "E-4",
      trigger: { kind: "error", eventId: "E-3" },
      tree: DECLINED
    });
    expect(result.before).toMatchObject({ eventId: "E-2", tree: FORM });
    // The first snapshot after the error is the linked one: it is not repeated.
    expect(result.after).toBeUndefined();
    expect(result.snapshotsInArchive).toBe(3);
    expect(result.note).toMatch(/viewport/u);
  });

  it("resolves actions and times", async () => {
    const path = await createFixture();

    expect((await getPageStateAt({ actionId: "A-1" }, archiveAt(path))).linked?.eventId).toBe(
      "E-2"
    );
    expect((await getPageStateAt({ mono: 4_500 }, archiveAt(path))).before?.eventId).toBe("E-4");
  });

  it("keeps whole lines within the size budget and says how many were cut", async () => {
    const path = await createFixture(
      Array.from({ length: 400 }, (_, index) => `- link "Result ${index}"`).join("\n")
    );
    const result = await getPageStateAt({ eventId: "E-3", maxChars: 1_000 }, archiveAt(path));
    const trees = [result.linked, result.before, result.after].map((entry) => entry?.tree ?? "");

    expect(trees.join("").length).toBeLessThanOrEqual(1_000);
    expect(result.linked?.tree).toBe(DECLINED);
    expect(result.before?.tree.split("\n").every((line) => line.startsWith("- "))).toBe(true);
    expect(result.before?.treeLinesCut).toBeGreaterThan(0);
  });

  it("rejects ambiguous and unknown anchors", async () => {
    const path = await createFixture();

    await expect(getPageStateAt({}, archiveAt(path))).rejects.toThrow(/exactly one/u);
    await expect(getPageStateAt({ eventId: "E-3", mono: 1 }, archiveAt(path))).rejects.toThrow(
      /exactly one/u
    );
    await expect(getPageStateAt({ eventId: "nope" }, archiveAt(path))).rejects.toThrow(
      /not found/u
    );
  });
});

describe("find_on_page", () => {
  it("reports when the alert appeared and disappeared", async () => {
    const path = await createFixture();
    const result = await findOnPageInArchive({ role: "alert" }, archiveAt(path));

    expect(result).toMatchObject({
      snapshotsScanned: 3,
      presentAtEnd: false,
      spansOmitted: 0,
      spans: [
        {
          appeared: { eventId: "E-4" },
          disappeared: { eventId: "E-5" },
          sample: ['alert: "Card declined"']
        }
      ]
    });
  });

  it("needs a text or a role and limits the spans", async () => {
    const path = await createFixture();

    await expect(findOnPageInArchive({}, archiveAt(path))).rejects.toThrow(/text, a role/u);
    expect(await findOnPageInArchive({ text: "pay", limit: 1 }, archiveAt(path))).toMatchObject({
      presentAtEnd: true,
      spans: [{ appeared: { eventId: "E-2" } }],
      spansOmitted: 0
    });
  });
});

describe("splitBudget", () => {
  it("passes what a short tree leaves on to the longer ones", () => {
    expect(splitBudget([100, 5_000, 0], 1_000)).toEqual([100, 900, 0]);
    expect(splitBudget([3_000, 3_000, 3_000], 900)).toEqual([300, 300, 300]);
    expect(splitBudget([10, 20, 30], 1_000)).toEqual([10, 20, 30]);
  });
});

function archiveAt(path: string): ArchiveHandle {
  return { path, open: (range) => openArchivePlayer(path, undefined, range) };
}

async function createFixture(firstTree: string = FORM): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wb-mcp-page-state-"));
  const archivePath = join(root, "session.webblackbox");

  tempDirs.push(root);
  await writeFile(
    archivePath,
    await createArchive([
      event("E-1", "user.click", 1_000, { x: 1, y: 2 }, "A-1"),
      event(
        "E-2",
        "dom.a11y.snapshot",
        1_700,
        snapshot(firstTree, { kind: "action", eventId: "E-1" }),
        "A-1"
      ),
      event("E-3", "error.exception", 3_000, { message: "declined" }),
      event(
        "E-4",
        "dom.a11y.snapshot",
        3_300,
        snapshot(DECLINED, { kind: "error", eventId: "E-3" })
      ),
      event("E-5", "dom.a11y.snapshot", 6_000, snapshot(FORM, { kind: "stop" }))
    ])
  );

  return archivePath;
}

function snapshot(tree: string, trigger: DomA11ySnapshotData["trigger"]): DomA11ySnapshotData {
  return {
    trigger,
    url: "https://shop.test/checkout",
    viewport: { w: 1280, h: 720, scrollX: 0, scrollY: 0 },
    scope: "viewport",
    tree,
    nodeCount: tree.split("\n").length,
    omittedNodes: 0,
    truncated: false,
    masking: "masked",
    durationMs: 2
  };
}

function event(
  id: string,
  type: WebBlackboxEvent["type"],
  mono: number,
  data: unknown,
  act?: string
): WebBlackboxEvent {
  return {
    v: 1,
    sid: "S-1",
    tab: 1,
    t: 1_000 + mono,
    mono,
    type,
    id,
    data,
    ...(act ? { ref: { act } } : {})
  };
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
    mode: "lite",
    site: { origin: "https://shop.test", title: "Page state fixture" },
    chunkCodec: "none",
    redactionProfile: {
      redactHeaders: [],
      redactCookieNames: [],
      redactBodyPatterns: [],
      blockedSelectors: [],
      hashSensitiveValues: true
    },
    stats: { eventCount: events.length, chunkCount: 1, blobCount: 0, durationMs: 5_000 }
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
