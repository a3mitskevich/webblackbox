import type JSZip from "jszip";

/** Writes `integrity/hashes.json` the way the pipeline exporter does, for hand-built fixtures. */
export async function writeIntegrityManifest(zip: JSZip): Promise<void> {
  const fileHashes: Record<string, string> = {};

  for (const path of Object.keys(zip.files).sort()) {
    if (path === "integrity/hashes.json") {
      continue;
    }

    const file = zip.file(path);

    if (!file) {
      continue;
    }

    fileHashes[path] = await sha256HexForTest(await file.async("uint8array"));
  }

  zip.file(
    "integrity/hashes.json",
    JSON.stringify(
      {
        manifestSha256: fileHashes["manifest.json"] ?? "",
        files: fileHashes
      },
      null,
      2
    )
  );
}

export async function sha256HexForTest(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
