import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import JSZip from "jszip";
import type { ExportManifest, WebBlackboxEvent } from "@webblackbox/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { domAt, domDiff, elementContext } from "./dom-tools.js";

// Real recordings shared with player-sdk's tests (see its test-support/rrweb-fixtures.ts).
const FIXTURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/player-sdk/src/__fixtures__/rrweb"
);

function fixture(name: string): WebBlackboxEvent[] {
  return JSON.parse(
    gunzipSync(readFileSync(join(FIXTURES, `${name}.json.gz`))).toString("utf8")
  ) as WebBlackboxEvent[];
}

const realistic = fixture("realistic-site-lite");
const heavy = fixture("heavy-spa-600-lite");
let root = "";
let realisticPath = "";
let heavyPath = "";
let emptyPath = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "wb-mcp-dom-"));
  realisticPath = join(root, "realistic.webblackbox");
  heavyPath = join(root, "heavy.webblackbox");
  emptyPath = join(root, "empty.webblackbox");
  await writeFile(realisticPath, await createArchive(realistic));
  await writeFile(heavyPath, await createArchive(heavy));
  await writeFile(
    emptyPath,
    await createArchive([
      { v: 1, sid: "S", tab: 1, t: 1, mono: 1, type: "console.entry", id: "E-1", data: {} }
    ])
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const firstClick = () => realistic.find((event) => event.type === "user.click")!;

describe("dom_at", () => {
  it("renders the page at the end of the session with wb-ids and the recorder state", async () => {
    const result = await domAt({ path: realisticPath });

    expect(result).toMatchObject({ available: true, format: "html" });
    if (!result.available) throw new Error("unavailable");
    expect(result.recording.url).toMatch(/\/app\/$/);
    expect(result.recording.gap).toBeNull();
    expect(result.roots[0]?.content).toMatch(/^<!DOCTYPE html><html wb-id="\d+"/);
    expect(result.roots[0]?.content).toContain('id="refresh"');
  });

  it("answers a selector at an event's time, as an outline", async () => {
    const result = await domAt({
      path: realisticPath,
      eventId: firstClick().id,
      selector: "button#refresh",
      format: "outline"
    });

    if (!result.available) throw new Error("unavailable");
    expect(result.at.eventId).toBe(firstClick().id);
    expect(result.matches).toMatchObject({ selector: "button#refresh", total: 1 });
    expect(result.roots[0]?.content).toMatch(/^button#refresh \[\d+\]/);
  });

  it("drills into a node and keeps to the byte budget", async () => {
    const page = await domAt({ path: heavyPath, maxBytes: 1_000, depth: 3 });

    if (!page.available) throw new Error("unavailable");
    const root = page.roots[0]!;
    expect(root.bytes).toBeLessThanOrEqual(1_100);
    expect(root.omittedNodeIds.length).toBeGreaterThan(0);

    const deeper = await domAt({
      path: heavyPath,
      nodeId: root.omittedNodeIds[0]!,
      maxBytes: 2_000
    });
    if (!deeper.available) throw new Error("unavailable");
    expect(deeper.roots[0]?.nodeId).toBe(root.omittedNodeIds[0]);
  });

  it("reports a recorder gap at the moment asked for", async () => {
    const paused = heavy.find(
      (event) => (event.data as { recorder?: { status?: string } }).recorder?.status === "paused"
    )!;
    const result = await domAt({ path: heavyPath, mono: paused.mono + 50 });

    if (!result.available) throw new Error("unavailable");
    expect(result.recording.gap).toMatchObject({ status: "paused", reason: "mutation-size" });
  });

  it("explains when there is no DOM, and rejects bad input", async () => {
    await expect(domAt({ path: emptyPath })).resolves.toMatchObject({
      available: false,
      firstSnapshotMono: null
    });
    await expect(domAt({ path: realisticPath, mono: 0 })).resolves.toMatchObject({
      available: false
    });
    await expect(domAt({ path: realisticPath, selector: "li:hover" })).rejects.toThrow(
      /Unsupported selector/
    );
    await expect(domAt({ path: realisticPath, nodeId: 999_999 })).rejects.toThrow(/not in the DOM/);
    await expect(domAt({ path: realisticPath, eventId: "nope" })).rejects.toThrow(/not found/);
  });
});

describe("element_context", () => {
  it("resolves an action to its clicked element with surroundings", async () => {
    const click = firstClick();
    const actionId = (click.ref as { act: string }).act;
    const result = await elementContext({ path: realisticPath, actionId });

    if (!result.available) throw new Error("unavailable");
    expect(result.target).toMatchObject({
      actionId,
      eventId: click.id,
      how: "rrweb click recorded with the event",
      tag: "h1"
    });
    expect(result.target.attributes["data-measure-click"]).toBe("0");
    expect(result.target.path).toMatch(/^html > body > .*h1/);
    expect(result.outerHtml.content).toMatch(/^<h1 wb-id="\d+"/);
    expect(result.ancestors.at(-1)?.label).toBe("html");
    expect(result.siblings.after.length + result.siblings.before.length).toBeGreaterThan(0);
  });

  it("takes an event or a node id, and says why there is no target", async () => {
    const byEvent = await elementContext({ path: heavyPath, eventId: heavyClick("nav-1").id });
    if (!byEvent.available) throw new Error("unavailable");
    expect(byEvent.target.attributes.id).toBe("nav-1");

    const byNode = await elementContext({
      path: heavyPath,
      nodeId: byEvent.target.nodeId,
      mono: byEvent.target.mono
    });
    if (!byNode.available) throw new Error("unavailable");
    expect(byNode.target).toMatchObject({ how: "nodeId", tag: "button" });

    const inGap = heavy.filter((event) => event.type === "user.click").at(-1)!;
    await expect(elementContext({ path: heavyPath, eventId: inGap.id })).rejects.toThrow(
      /DOM recorder was paused/
    );
    await expect(elementContext({ path: heavyPath })).rejects.toThrow(
      /actionId, eventId, or nodeId/
    );
    await expect(elementContext({ path: heavyPath, actionId: "A-nope" })).rejects.toThrow(
      /not found/
    );
  });
});

/** The user.click whose rrweb target is the element with this id (heavy fixture). */
function heavyClick(targetId: string): WebBlackboxEvent {
  const clicks = heavy.filter((event) => event.type === "user.click");
  // nav-1 is the session's first click.
  return targetId === "nav-1" ? clicks[0]! : clicks.find((event) => event.id === targetId)!;
}

describe("dom_diff", () => {
  it("shows what a route change did", async () => {
    const click = heavyClick("nav-1");
    const resumed = heavy.find(
      (event) => (event.data as { recorder?: { status?: string } }).recorder?.status === "resumed"
    )!;
    // Up to the fresh full snapshot that ends the pause the route change caused.
    const windowMs = Math.ceil(resumed.mono - click.mono) + 50;
    const result = await domDiff({ path: heavyPath, eventId: click.id, windowMs });

    if (!result.available) throw new Error("unavailable");
    expect(result.around).toEqual({ actionId: null, eventId: click.id });
    expect(result.from).toBe(click.mono - 1);
    expect(result.gaps?.[0]).toMatchObject({ status: "paused", reason: "mutation-size" });
    // Across the resume rrweb has new ids: compared by structure.
    expect(result.matchedBy).toBe("path");
    expect(result.counts.attributes + result.counts.texts).toBeGreaterThan(0);
  });

  it("compares two moments within a byte budget", async () => {
    const monos = realistic
      .filter((event) => event.type === "dom.rrweb.event")
      .map((event) => event.mono);
    const result = await domDiff({
      path: realisticPath,
      fromMono: Math.min(...monos),
      toMono: Math.max(...monos),
      maxBytes: 1_000
    });

    if (!result.available) throw new Error("unavailable");
    expect(result.fromNote).toMatch(/first full snapshot/);
    expect(JSON.stringify(result).length).toBeLessThan(3_000);
    await expect(domDiff({ path: realisticPath, fromMono: 1 })).rejects.toThrow(
      /fromMono and toMono/
    );
  });
});

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
    site: { origin: "http://127.0.0.1", title: "DOM fixture" },
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
