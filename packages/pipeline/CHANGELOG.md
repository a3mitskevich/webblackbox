# @webblackbox/pipeline

## 0.7.0

### Minor Changes

- Archive format 2: every export is encrypted and the passphrase is now mandatory — `exportBundle`/`createWebBlackboxArchive` throw without one. `manifest.json` carries only the plaintext envelope; the full manifest moves to encrypted `meta/manifest.json`, `protocolVersion` is 2, all entries are AES-GCM encrypted, and the default KDF cost rises to 600,000 iterations. Reading format 1 archives is unchanged.
- Removed the `assertPrivacyScannerPassed` export and the `strictPrivacyScanner`, `allowPlaintextLocalExport`, and `trustedPlaintextExemptionEvidenceRefs` options; the privacy scanner no longer blocks export.
- Added the `@webblackbox/pipeline/storage` subpath export (storage and session sweep without jszip), `sweepPipelineSessions`, `generatePipelineStorageKeyBytes`/`importPipelineStorageKey`, `EncryptedPipelineStorage.listSessions`/`purgeUnreadableSessions`, optional `PipelineStorage.listSessions`, and `computeChunkTimeBounds`.
- At-rest encrypted storage now seals whole session/index/integrity records, not only chunk and blob bytes; legacy rows are still read or purged when the key is lost.
- WebSocket/SSE stream payloads above 16 KB are externalized to a blob with a preview and hash during ingest.

### Patch Changes

- Chunk time bounds are now the min/max over chunk events instead of first/last, and IndexedDB blob tracking no longer loses blobs under parallel writes.
- Updated dependencies
  - @webblackbox/protocol@0.7.0

## 0.6.0

### Minor Changes

- Added independent export filtering for screen-recording events and blobs through `includeScreenRecordings`.
- Included screen-recording selection in export transfer-policy metadata and low-risk plaintext override checks.

### Patch Changes

- Updated dependencies
  - @webblackbox/protocol@0.6.0

## 0.5.0

### Minor Changes

- Rolled up the post-0.4.5 privacy/export pipeline: archives now carry scanner results, export transfer policy metadata, encrypted private indexes/blobs, real-user encryption enforcement, and trusted plaintext exemption checks.
- Added explicit support for local plaintext exports through `allowPlaintextLocalExport`, while privacy findings now warn instead of blocking local downloads by default.
- Applied default export policy bounds consistently and kept returned archive integrity metadata stable after export.

### Patch Changes

- Updated dependencies
  - @webblackbox/protocol@0.5.0

## 0.4.6

### Patch Changes

- Added an explicit `allowPlaintextLocalExport` export option for trusted local download flows that intentionally leave archives unencrypted while preserving encrypted exports when a passphrase is supplied.

## 0.4.5

### Patch Changes

- No pipeline runtime changes shipped in this release. The version bump keeps the package aligned with the 0.4.5 capture performance, privacy preflight, and replay diagnostics workspace release.
- Updated dependencies
  - @webblackbox/protocol@0.4.5

## 0.4.4

### Patch Changes

- No pipeline runtime changes shipped in this release. The version bump keeps the pipeline package aligned with the Player timeline and marker fixes in the 0.4.4 workspace release.
- Updated dependencies
  - @webblackbox/protocol@0.4.4

## 0.4.3

### Changed

- No package-specific runtime changes shipped in this release. The version bump keeps the pipeline package aligned with the extension-focused 0.4.3 workspace release.

## 0.4.2

### Changed

- No package-specific runtime changes shipped in this release. The version bump keeps the pipeline package aligned with the 0.4.2 workspace release.

## 0.4.1

### Changed

- No package-specific runtime changes shipped in this release. The version bump keeps the pipeline package aligned with the 0.4.1 workspace release.

## 0.4.0

### Changed

- Resumed chunk sequence numbers from stored session state after recovery so restarted pipelines stop overwriting earlier chunks for the same session.
- Anchored `recentWindowMs` exports to the latest session activity for completed sessions instead of the export wall clock time.
- Enforced archive integrity manifests on read, including file-set verification and per-file hash checks, and aligned request indexing with nested `request.requestId` payloads.
- Added a Node `crypto` fallback for SHA-256 hashing when Web Crypto is unavailable in Node-based archive tooling.

## 0.3.0

### Changed

- No package-specific runtime changes shipped in this release. The version bump keeps the pipeline package aligned with the extension-focused 0.3.0 workspace release.

## 0.2.0

### Changed

- No package-specific runtime changes in this release. The version bump keeps the pipeline package aligned with the 0.2.0 workspace release.

## 0.1.3

### Changed

- No package-specific runtime changes in this release. The version bump keeps the pipeline package aligned with the 0.1.3 workspace release.

## 0.1.2

### Changed

- Refreshed the package README to better document archive export, persistence, and storage responsibilities.

## 0.1.1

### Changed

- No package-specific source changes in this release. The version bump kept the pipeline package aligned with the post-0.1.0 workspace release.

## 0.1.0

### Added

- Initial archive pipeline with chunk/blob storage, encrypted export support, and pluggable persistence backends.
