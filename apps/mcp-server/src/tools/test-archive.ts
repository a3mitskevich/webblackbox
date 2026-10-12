import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";
import type { ExportManifest, WebBlackboxEvent } from "@webblackbox/protocol";

/** Test-only builder of small format-1 archives with events and blobs. */

export type FixtureBlob = { hash: string; extension: string; bytes: Uint8Array };

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fixtureBlob(content: Uint8Array | string, extension: string): FixtureBlob {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return { hash: sha256Hex(bytes), extension, bytes };
}

export function fixtureEvent(
  id: string,
  type: string,
  mono: number,
  data: unknown = {},
  extra: Partial<WebBlackboxEvent> = {}
): WebBlackboxEvent {
  return {
    v: 1,
    sid: "S-1",
    tab: 1,
    t: 1_700_000_000_000 + mono,
    mono,
    type: type as WebBlackboxEvent["type"],
    id,
    data,
    ...extra
  };
}

export async function buildArchiveBytes(
  events: readonly WebBlackboxEvent[],
  blobs: readonly FixtureBlob[] = []
): Promise<Uint8Array> {
  const zip = new JSZip();
  const files = new Map<string, Uint8Array>();
  const add = (path: string, content: Uint8Array | string): void => {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    zip.file(path, bytes);
    files.set(path, bytes);
  };
  const requestIds = new Map<string, string[]>();

  for (const event of events) {
    if (event.ref?.req) {
      requestIds.set(event.ref.req, [...(requestIds.get(event.ref.req) ?? []), event.id]);
    }
  }

  const first = events[0]?.mono ?? 0;
  const last = events[events.length - 1]?.mono ?? first;
  const manifest: ExportManifest = {
    protocolVersion: 1,
    createdAt: new Date(0).toISOString(),
    mode: "full",
    site: { origin: "https://shop.example", title: "Fixture" },
    chunkCodec: "none",
    redactionProfile: {
      redactHeaders: [],
      redactCookieNames: [],
      redactBodyPatterns: [],
      blockedSelectors: [],
      hashSensitiveValues: false
    },
    stats: {
      eventCount: events.length,
      chunkCount: 1,
      blobCount: blobs.length,
      durationMs: Math.max(0, last - first)
    }
  };

  add("manifest.json", JSON.stringify(manifest));
  add("index/time.json", "[]");
  add(
    "index/req.json",
    JSON.stringify([...requestIds].map(([reqId, eventIds]) => ({ reqId, eventIds })))
  );
  add("index/inv.json", "[]");
  add("events/chunk-000001.ndjson", events.map((event) => JSON.stringify(event)).join("\n"));

  for (const blob of blobs) {
    add(`blobs/sha256-${blob.hash}.${blob.extension}`, blob.bytes);
  }

  const hashes = Object.fromEntries([...files].map(([path, bytes]) => [path, sha256Hex(bytes)]));
  zip.file(
    "integrity/hashes.json",
    JSON.stringify({ manifestSha256: hashes["manifest.json"], files: hashes })
  );

  return zip.generateAsync({ type: "uint8array" });
}

/** Temp directories that the tests remove in `afterEach`. */
export function createTempDirs(): {
  make(prefix: string): Promise<string>;
  cleanup(): Promise<void>;
} {
  const dirs: string[] = [];

  return {
    make: async (prefix) => {
      const dir = await mkdtemp(join(tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
    cleanup: async () => {
      await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    }
  };
}

export async function writeArchive(
  dir: string,
  events: readonly WebBlackboxEvent[],
  blobs: readonly FixtureBlob[] = []
): Promise<string> {
  const path = join(dir, "session.webblackbox");
  await writeFile(path, await buildArchiveBytes(events, blobs));
  return path;
}
