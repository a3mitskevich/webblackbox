import * as zlib from "node:zlib";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { DEFAULT_CAPTURE_POLICY } from "@webblackbox/protocol";
import type { ChunkCodec, ChunkTimeIndexEntry, ExportManifest } from "@webblackbox/protocol";

import { ArchiveLimitError, DEFAULT_ARCHIVE_LOAD_LIMITS, WebBlackboxPlayer } from "./index.js";

const MIB = 1024 * 1024;
const CHUNK_PATH = "events/chunk-000001.ndjson";
const PASSPHRASE = "hardening-passphrase";

type ChunkFixture = {
  chunkId: string;
  bytes: Uint8Array;
  codec: ChunkCodec;
};

type ArchiveFixtureOptions = {
  manifest?: Record<string, unknown>;
  chunks?: ChunkFixture[];
  timeIndex?: unknown;
  extraFiles?: Record<string, Uint8Array | string>;
  encryption?: { iterations: number; encryptChunks: boolean };
};

describe("archive load hardening", () => {
  it("exposes conservative default limits", () => {
    expect(DEFAULT_ARCHIVE_LOAD_LIMITS).toEqual({
      maxEntries: 100_000,
      maxEntryUncompressedBytes: 256 * MIB,
      maxTotalUncompressedBytes: 1024 * MIB,
      maxDecodedChunkBytes: 256 * MIB,
      maxTotalDecodedChunkBytes: 1024 * MIB
    });
  });

  it("opens a well-formed archive with default limits", async () => {
    const player = await WebBlackboxPlayer.open(await createArchive());

    expect(player.events.map((event) => event.id)).toEqual(["E-1"]);
  });

  it("rejects an entry whose declared size exceeds the per-entry limit before inflating", async () => {
    const archive = patchDeclaredUncompressedSize(
      await createArchive({ extraFiles: { "blobs/sha256-bomb.bin": new Uint8Array(64) } }),
      "blobs/sha256-bomb.bin",
      0xf000_0000
    );

    const error = await WebBlackboxPlayer.open(archive).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ArchiveLimitError);
    expect((error as Error).message).toMatch(
      /'blobs\/sha256-bomb\.bin' declares 4026531840 uncompressed bytes.*per-entry limit of 268435456/
    );
  });

  it("rejects archives whose declared total uncompressed size exceeds the limit", async () => {
    const blobPaths = Array.from({ length: 5 }, (_, index) => `blobs/sha256-bomb${index}.bin`);
    let archive = await createArchive({
      extraFiles: Object.fromEntries(blobPaths.map((path) => [path, new Uint8Array(8)]))
    });

    for (const path of blobPaths) {
      archive = patchDeclaredUncompressedSize(archive, path, 256 * MIB);
    }

    await expect(WebBlackboxPlayer.open(archive)).rejects.toThrow(
      /total uncompressed limit of 1073741824 bytes/
    );
  });

  it("rejects a small zip that inflates far beyond its declared size", async () => {
    const bombPayload = new TextEncoder().encode(
      `${JSON.stringify(createEvent("E-1"))}\n${" ".repeat(4 * MIB)}`
    );
    const archive = patchDeclaredUncompressedSize(
      await createArchive({
        chunks: [{ chunkId: "chunk-000001", bytes: bombPayload, codec: "none" }]
      }),
      CHUNK_PATH,
      512
    );

    expect(archive.byteLength).toBeLessThan(64 * 1024);
    await expect(WebBlackboxPlayer.open(archive)).rejects.toThrow(
      /'events\/chunk-000001\.ndjson' inflates beyond its declared size of 512 bytes/
    );
  });

  it("enforces caller-provided per-entry and total limits", async () => {
    const archive = await createArchive({
      extraFiles: { "blobs/sha256-zeros.bin": new Uint8Array(2 * MIB) }
    });

    await expect(
      WebBlackboxPlayer.open(archive, { limits: { maxEntryUncompressedBytes: MIB } })
    ).rejects.toThrow(/per-entry limit of 1048576 bytes/);
    await expect(
      WebBlackboxPlayer.open(archive, { limits: { maxTotalUncompressedBytes: MIB } })
    ).rejects.toThrow(/total uncompressed limit of 1048576 bytes/);
    await expect(
      WebBlackboxPlayer.open(archive, { limits: { maxTotalUncompressedBytes: 4 * MIB } })
    ).resolves.toBeInstanceOf(WebBlackboxPlayer);
  });

  it("rejects archives with too many entries", async () => {
    const archive = await createArchive({
      extraFiles: { "blobs/sha256-a.bin": "a", "blobs/sha256-b.bin": "b" }
    });

    await expect(WebBlackboxPlayer.open(archive, { limits: { maxEntries: 4 } })).rejects.toThrow(
      /entries, more than the limit of 4/
    );
  });

  it("rejects invalid limit overrides", async () => {
    const archive = await createArchive();

    await expect(WebBlackboxPlayer.open(archive, { limits: { maxEntries: 0 } })).rejects.toThrow(
      /limits\.maxEntries must be a positive integer/
    );
    await expect(
      WebBlackboxPlayer.open(archive, { limits: { maxDecodedChunkBytes: Number.NaN } })
    ).rejects.toThrow(/limits\.maxDecodedChunkBytes must be a positive integer/);
  });

  for (const codec of supportedCodecs()) {
    it(`rejects a ${codec} event chunk that decodes beyond the per-chunk limit`, async () => {
      const decoded = new TextEncoder().encode(
        `${JSON.stringify(createEvent("E-1"))}\n${"\n".repeat(4 * MIB)}`
      );
      const archive = await createArchive({
        chunks: [{ chunkId: "chunk-000001", bytes: compress(decoded, codec), codec }]
      });

      const error = await WebBlackboxPlayer.open(archive, {
        limits: { maxDecodedChunkBytes: MIB }
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ArchiveLimitError);
      expect((error as Error).message).toMatch(
        new RegExp(`'${CHUNK_PATH}' \\(${codec}\\) exceeds the per-chunk decoded limit of 1048576`)
      );
      await expect(WebBlackboxPlayer.open(archive)).resolves.toBeInstanceOf(WebBlackboxPlayer);
    });
  }

  it("rejects archives whose decoded event chunks exceed the total decoded limit", async () => {
    const padding = "\n".repeat(600 * 1024);
    const archive = await createArchive({
      chunks: [
        {
          chunkId: "chunk-000001",
          bytes: compress(encodeText(`${JSON.stringify(createEvent("E-1"))}${padding}`), "gzip"),
          codec: "gzip"
        },
        {
          chunkId: "chunk-000002",
          bytes: compress(encodeText(`${JSON.stringify(createEvent("E-2"))}${padding}`), "gzip"),
          codec: "gzip"
        }
      ]
    });

    await expect(
      WebBlackboxPlayer.open(archive, { limits: { maxTotalDecodedChunkBytes: MIB } })
    ).rejects.toThrow(/'events\/chunk-000002\.ndjson' \(gzip\) exceeds the total decoded limit/);
  });

  it("rejects an unknown protocolVersion with a clear message", async () => {
    const archive = await createArchive({ manifest: { protocolVersion: 2 } });

    await expect(WebBlackboxPlayer.open(archive)).rejects.toThrow(
      "Unsupported archive protocolVersion 2; this player supports protocolVersion 1."
    );
  });

  it("rejects a manifest that does not match the protocol schema", async () => {
    const archive = await createArchive({ manifest: { mode: "turbo", stats: { eventCount: -1 } } });

    await expect(WebBlackboxPlayer.open(archive)).rejects.toThrow(
      /^Invalid archive manifest\.json: mode: .*; stats\.eventCount: /
    );
  });

  it("rejects manifests that are not JSON objects", async () => {
    const archive = await createArchive({ manifest: { replaceWith: "not-json" } });

    await expect(WebBlackboxPlayer.open(archive)).rejects.toThrow(
      /^Archive file manifest\.json is not valid JSON/
    );
  });

  it("rejects malformed index files", async () => {
    const archive = await createArchive({ timeIndex: [{ chunkId: "chunk-000001" }] });

    await expect(WebBlackboxPlayer.open(archive)).rejects.toThrow(
      /^Invalid archive index\/time\.json: 0\.seq: /
    );
  });

  it("rejects a malformed integrity manifest", async () => {
    const source = await JSZip.loadAsync(await createArchive());
    source.file("integrity/hashes.json", JSON.stringify({ manifestSha256: 7, files: [] }));
    const archive = await source.generateAsync({ type: "uint8array" });

    await expect(WebBlackboxPlayer.open(archive)).rejects.toThrow(
      /^Invalid archive integrity\/hashes\.json: manifestSha256: /
    );
  });

  it("rejects KDF iteration counts outside the supported range before deriving a key", async () => {
    for (const iterations of [50_000_000, 1_000]) {
      const archive = await createArchive({
        encryption: { iterations, encryptChunks: false }
      });

      await expect(WebBlackboxPlayer.open(archive, { passphrase: PASSPHRASE })).rejects.toThrow(
        /^Invalid archive manifest\.json: encryption\.kdf\.iterations: /
      );
    }
  });

  it("opens v0.5.0 archives whose privacy manifest policy predates screen recordings", async () => {
    const legacyCategories = Object.fromEntries(
      Object.entries(DEFAULT_CAPTURE_POLICY.categories).filter(
        ([key]) => key !== "screenRecordings"
      )
    );
    const legacyPrivacyManifest = {
      schemaVersion: 1,
      generatedAt: new Date(0).toISOString(),
      effectivePolicy: { ...DEFAULT_CAPTURE_POLICY, categories: legacyCategories },
      consent: DEFAULT_CAPTURE_POLICY.consent,
      categories: [],
      scanner: {
        scannedAt: new Date(0).toISOString(),
        preEncryption: true,
        status: "passed",
        findings: []
      },
      encryption: { archive: "plaintext" },
      totals: { events: 1, blobs: 0, privacyViolations: 0 }
    };
    const archive = await createArchive({
      extraFiles: { "privacy/manifest.json": JSON.stringify(legacyPrivacyManifest) }
    });

    const player = await WebBlackboxPlayer.open(archive);

    expect(player.archive.privacyManifest?.effectivePolicy?.categories.screenRecordings).toBe(
      "off"
    );
  });

  it("opens encrypted archives written with legacy (120k) and current (600k) KDF iterations", async () => {
    for (const iterations of [120_000, 600_000]) {
      const archive = await createArchive({ encryption: { iterations, encryptChunks: true } });
      const player = await WebBlackboxPlayer.open(archive, { passphrase: PASSPHRASE });

      expect(player.archive.manifest.encryption?.kdf.iterations).toBe(iterations);
      expect(player.events.map((event) => event.id)).toEqual(["E-1"]);
    }
  });
});

function createEvent(id: string): Record<string, unknown> {
  return { v: 1, sid: "S-1", tab: 1, t: 1000, mono: 1, type: "meta.session.start", id, data: {} };
}

function createManifest(): ExportManifest {
  return {
    protocolVersion: 1,
    createdAt: new Date(0).toISOString(),
    mode: "full",
    site: { origin: "https://example.com" },
    chunkCodec: "none",
    redactionProfile: {
      redactHeaders: [],
      redactCookieNames: [],
      redactBodyPatterns: [],
      blockedSelectors: [],
      hashSensitiveValues: true
    },
    stats: { eventCount: 1, chunkCount: 1, blobCount: 0, durationMs: 0 }
  };
}

async function createArchive(options: ArchiveFixtureOptions = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  const chunks = options.chunks ?? [
    {
      chunkId: "chunk-000001",
      bytes: encodeText(JSON.stringify(createEvent("E-1"))),
      codec: "none"
    }
  ];
  const timeIndex: ChunkTimeIndexEntry[] = chunks.map((chunk, index) => ({
    chunkId: chunk.chunkId,
    seq: index + 1,
    tStart: 1000,
    tEnd: 1000,
    monoStart: 1,
    monoEnd: 1,
    eventCount: 1,
    byteLength: chunk.bytes.byteLength,
    codec: chunk.codec,
    sha256: "unused"
  }));
  const encryption = options.encryption
    ? await createEncryptionState(options.encryption.iterations, options.encryption.encryptChunks)
    : null;

  for (const chunk of chunks) {
    const path = `events/${chunk.chunkId}.ndjson`;
    const bytes =
      encryption && options.encryption?.encryptChunks
        ? await encryption.encrypt(path, chunk.bytes)
        : chunk.bytes;
    zip.file(path, bytes);
  }

  zip.file("index/time.json", JSON.stringify(options.timeIndex ?? timeIndex));
  zip.file("index/req.json", JSON.stringify([]));
  zip.file("index/inv.json", JSON.stringify([]));

  for (const [path, content] of Object.entries(options.extraFiles ?? {})) {
    zip.file(path, content);
  }

  const { replaceWith, ...manifestOverrides } = options.manifest ?? {};
  const manifest = {
    ...createManifest(),
    ...manifestOverrides,
    ...(encryption ? { encryption: encryption.meta } : {})
  };
  zip.file(
    "manifest.json",
    typeof replaceWith === "string" ? replaceWith : JSON.stringify(manifest)
  );

  await writeIntegrityManifest(zip);

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

async function writeIntegrityManifest(zip: JSZip): Promise<void> {
  const files: Record<string, string> = {};

  for (const path of Object.keys(zip.files).sort()) {
    const file = zip.file(path);

    if (file) {
      files[path] = await sha256Hex(await file.async("uint8array"));
    }
  }

  zip.file(
    "integrity/hashes.json",
    JSON.stringify({ manifestSha256: files["manifest.json"] ?? "", files })
  );
}

/** Builds manifest encryption metadata; derives a real key only when chunks get encrypted. */
async function createEncryptionState(
  iterations: number,
  deriveKey: boolean
): Promise<{
  meta: NonNullable<ExportManifest["encryption"]>;
  encrypt: (path: string, bytes: Uint8Array) => Promise<Uint8Array>;
}> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const meta: NonNullable<ExportManifest["encryption"]> = {
    algorithm: "AES-GCM",
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations,
      saltBase64: Buffer.from(salt).toString("base64")
    },
    files: {}
  };

  if (!deriveKey) {
    return {
      meta,
      encrypt: () => Promise.reject(new Error("Encryption key was not derived."))
    };
  }

  const baseKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(encodeText(PASSPHRASE)),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", iterations, salt },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );

  return {
    meta,
    encrypt: async (path, bytes) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      meta.files[path] = { ivBase64: Buffer.from(iv).toString("base64") };
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new Uint8Array(bytes)
      );
      return new Uint8Array(encrypted);
    }
  };
}

/**
 * Rewrites the uncompressed size recorded for `entryPath` in both its local file header and its
 * central directory record, producing archives whose declared sizes lie about their content.
 */
function patchDeclaredUncompressedSize(
  source: Uint8Array,
  entryPath: string,
  size: number
): Uint8Array {
  const output = source.slice();
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  const name = encodeText(entryPath);
  let patched = 0;

  for (let offset = 0; offset + 46 <= output.byteLength; offset += 1) {
    const signature = view.getUint32(offset, true);

    if (
      signature === 0x04034b50 &&
      hasName(output, offset + 30, view.getUint16(offset + 26, true), name)
    ) {
      view.setUint32(offset + 22, size, true);
      patched += 1;
    } else if (
      signature === 0x02014b50 &&
      hasName(output, offset + 46, view.getUint16(offset + 28, true), name)
    ) {
      view.setUint32(offset + 24, size, true);
      patched += 1;
    }
  }

  if (patched !== 2) {
    throw new Error(`Expected to patch 2 headers for ${entryPath}, patched ${patched}.`);
  }

  return output;
}

function hasName(bytes: Uint8Array, offset: number, length: number, name: Uint8Array): boolean {
  return (
    length === name.byteLength && name.every((value, index) => bytes[offset + index] === value)
  );
}

function supportedCodecs(): Array<"gzip" | "br" | "zst"> {
  const codecs: Array<"gzip" | "br" | "zst"> = ["gzip", "br"];

  if (typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === "function") {
    codecs.push("zst");
  }

  return codecs;
}

function compress(bytes: Uint8Array, codec: "gzip" | "br" | "zst"): Uint8Array {
  if (codec === "gzip") {
    return new Uint8Array(zlib.gzipSync(bytes));
  }

  if (codec === "br") {
    return new Uint8Array(zlib.brotliCompressSync(bytes));
  }

  const zstd = (zlib as unknown as { zstdCompressSync: (input: Uint8Array) => Uint8Array })
    .zstdCompressSync;
  return new Uint8Array(zstd(bytes));
}

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(
    ""
  );
}
