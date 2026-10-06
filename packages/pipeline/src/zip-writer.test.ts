import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import type { ExportManifest } from "@webblackbox/protocol";
import { DEFAULT_REDACTION_PROFILE } from "@webblackbox/protocol";

import { ArchiveWriter, computeArchiveBytes } from "./archive-writer.js";
import { concatBytes, readWebBlackboxArchive } from "./exporter.js";
import { crc32, STORE_ZIP_END_BYTES, StoreZipWriter, storeZipEntryBytes } from "./zip-writer.js";

const PASSPHRASE = "zip-writer-passphrase";

async function writeZip(files: Array<[string, Uint8Array]>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const writer = new StoreZipWriter((part) => {
    parts.push(part);
  });

  for (const [path, bytes] of files) {
    await writer.addFile(path, bytes);
  }

  const size = await writer.finish();
  const archive = concatBytes(parts);

  expect(archive.byteLength).toBe(size);
  return archive;
}

function createManifest(): ExportManifest {
  return {
    protocolVersion: 2,
    createdAt: new Date(0).toISOString(),
    mode: "lite",
    site: { origin: "https://example.test/" },
    chunkCodec: "none",
    redactionProfile: DEFAULT_REDACTION_PROFILE,
    stats: { eventCount: 0, chunkCount: 0, blobCount: 0, durationMs: 0 }
  };
}

describe("StoreZipWriter", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("writes archives JSZip reads back, entry for entry", async () => {
    const files: Array<[string, Uint8Array]> = [
      ["events/C-000001.ndjson", new TextEncoder().encode('{"id":"E-1"}')],
      ["blobs/empty.bin", new Uint8Array()],
      ["index/ünïcode.json", Uint8Array.from({ length: 70_000 }, (_, index) => index % 251)]
    ];
    const archive = await writeZip(files);
    const zip = await JSZip.loadAsync(archive, { checkCRC32: true });

    expect(Object.keys(zip.files)).toEqual(files.map(([path]) => path));

    for (const [path, bytes] of files) {
      expect(await zip.file(path)?.async("uint8array")).toEqual(bytes);
    }
  });

  it("predicts the archive size from entry sizes alone", async () => {
    const files: Array<[string, Uint8Array]> = [
      ["a.txt", new Uint8Array(10)],
      ["dir/ü.bin", new Uint8Array(1234)]
    ];
    const archive = await writeZip(files);
    const predicted =
      STORE_ZIP_END_BYTES +
      files.reduce((sum, [path, bytes]) => sum + storeZipEntryBytes(path, bytes.byteLength), 0);

    expect(archive.byteLength).toBe(predicted);
  });

  it("refuses writes after the archive is finished", async () => {
    const writer = new StoreZipWriter(() => undefined);

    await writer.finish();

    await expect(writer.addFile("late.txt", new Uint8Array(1))).rejects.toThrow(/finished/);
    await expect(writer.finish()).rejects.toThrow(/finished/);
  });
});

describe("ArchiveWriter", () => {
  it("writes exactly the size computeArchiveBytes predicts", async () => {
    const parts: Uint8Array[] = [];
    const writer = await ArchiveWriter.create({
      passphrase: PASSPHRASE,
      sink: (part) => {
        parts.push(part);
      }
    });
    const chunk = new TextEncoder().encode('{"id":"E-1"}');
    const blob = { hash: "a".repeat(64), mime: "image/webp", bytes: new Uint8Array(4096) };
    const manifest = createManifest();
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

    await writer.addChunk("C-000001", chunk);
    await writer.addJson("index/time.json", [], "compact");
    await writer.addBlob(blob);
    const result = await writer.finish(manifest);
    const predicted = computeArchiveBytes(
      [
        { path: "events/C-000001.ndjson", plainBytes: chunk.byteLength },
        { path: "index/time.json", plainBytes: 2 },
        { path: `blobs/sha256-${blob.hash}.webp`, plainBytes: blob.bytes.byteLength }
      ],
      manifestBytes.byteLength
    );

    expect(result.sizeBytes).toBe(predicted);
    expect(concatBytes(parts).byteLength).toBe(predicted);
    expect(Object.keys(result.integrity.files)).toEqual([
      "events/C-000001.ndjson",
      "index/time.json",
      `blobs/sha256-${blob.hash}.webp`,
      "meta/manifest.json",
      "manifest.json"
    ]);
  });

  it("refuses to write without a valid passphrase", async () => {
    await expect(
      ArchiveWriter.create({ passphrase: "short", sink: () => undefined })
    ).rejects.toThrow();
  });

  it("produces archives the reader decrypts and verifies", async () => {
    const parts: Uint8Array[] = [];
    const writer = await ArchiveWriter.create({
      passphrase: PASSPHRASE,
      sink: (part) => {
        parts.push(part);
      }
    });
    const event = {
      v: 1,
      sid: "S-zip",
      tab: 1,
      id: "E-1",
      t: 1,
      mono: 1,
      type: "user.click",
      data: {}
    };

    await writer.addChunk("C-000001", new TextEncoder().encode(JSON.stringify(event)));
    await writer.addJson("index/time.json", [], "compact");
    await writer.addJson("index/req.json", [], "compact");
    await writer.addJson("index/inv.json", [], "compact");
    await writer.finish(createManifest());

    const parsed = await readWebBlackboxArchive(concatBytes(parts), { passphrase: PASSPHRASE });

    expect(parsed.events.map((entry) => entry.id)).toEqual(["E-1"]);
    expect(parsed.manifest.protocolVersion).toBe(2);
  });
});
