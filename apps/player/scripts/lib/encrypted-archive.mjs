// Encrypted (format 2) archive of a synthetic session, written by the real pipeline exporter, so
// the e2e exercises the same decryption path as archives exported by the extension.
import { buildPrivacyManifest, createWebBlackboxArchive } from "@webblackbox/pipeline";

import {
  buildArchiveIndexes,
  buildSyntheticSession,
  encodeEventChunk,
  SYNTHETIC_PASSPHRASE,
  SYNTHETIC_SESSION_ID
} from "./synthetic-session.mjs";

export async function createEncryptedArchive(
  session = buildSyntheticSession(),
  passphrase = SYNTHETIC_PASSPHRASE
) {
  const chunkBytes = encodeEventChunk(session.events);
  const indexes = buildArchiveIndexes(session, chunkBytes);
  const createdAt = Date.parse(session.manifest.createdAt);
  const blobs = session.blobs.map((blob) => ({
    hash: blob.hash,
    mime: blob.mime,
    size: blob.bytes.byteLength,
    bytes: blob.bytes,
    createdAt,
    refCount: 1
  }));
  const privacyManifest = await buildPrivacyManifest({
    events: session.events,
    blobs,
    encrypted: true,
    generatedAt: new Date(createdAt)
  });
  const archive = await createWebBlackboxArchive(
    {
      manifest: session.manifest,
      chunks: [{ sid: SYNTHETIC_SESSION_ID, meta: indexes.timeIndex[0], bytes: chunkBytes }],
      blobs,
      timeIndex: indexes.timeIndex,
      requestIndex: indexes.requestIndex,
      invertedIndex: indexes.invertedIndex,
      privacyManifest
    },
    { passphrase }
  );

  return archive.bytes;
}
