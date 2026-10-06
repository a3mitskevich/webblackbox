# @webblackbox/protocol

## 0.7.0

### Minor Changes

- Added archive format 2: every export is encrypted, `manifest.json` becomes a minimal plaintext envelope (`ArchiveEnvelopeManifest`), and the full manifest moves to encrypted `meta/manifest.json`. `ExportManifest.protocolVersion` widened to `1 | 2`; format 1 archives still validate.
- Added pointer, tabs-context, script-symbolication, and body-skip event types (`user.pointerdown/up`, `user.contextmenu`, `user.auxclick`, `user.click.reaction`, `user.drag.start/end`, `user.selection`, `user.wheel`, `user.hover`, `meta.tabs.snapshot`, `meta.tabs.change`, `sys.script`, `network.body.skipped`) with payload schemas.
- Added subpath exports `./schemas`, `./secret-detection`, `./linear-regex`, `./redaction-rules`, and `./archive-encryption` so page bundles can skip zod; switched to unbundled per-module output with `"sideEffects": false`.
- Added `normalizeMimeType`, recording-profile redaction fields, capture-policy categories for tabs context, and `BODY_SKIP_REASONS`/`isBodySkipReason` helpers.
- Changed `sanitizeUrlForPrivacy` output for `ws:`/`wss:` URLs (origin plus templated path instead of a fully redacted placeholder) and tightened archive KDF iteration validation to 10,000–10,000,000.

## 0.6.0

### Minor Changes

- Added screen-recording event types, validation schemas, and privacy categories for archive playback and filtering.
- Added `screenRecordings` capture policy and `includeScreenRecordings` export policy fields.
- Added WebM and MP4 blob MIME/extension inference for screen-recording chunks.

## 0.5.0

### Minor Changes

- Added capture privacy classification, capture-policy schema support, archive privacy scanner metadata, and export transfer-policy metadata shared by recorder, pipeline, and player tooling.
- Tightened privacy defaults and helpers by disabling body/screenshot capture by default, sanitizing URLs by default, and tokenizing file paths, target selectors, and secret-prefixed path segments.

## 0.4.5

### Patch Changes

- Expanded the default redaction profile to cover additional auth headers, token-like cookie names, sensitive body patterns, and DOM selectors before capture/export.

## 0.4.4

### Patch Changes

- No protocol schema or default changes shipped in this release. The version bump keeps the protocol package aligned with the Player timeline and marker fixes in the 0.4.4 workspace release.

## 0.4.3

### Changed

- No schema or default changes shipped in this release. The version bump keeps the protocol package aligned with the extension-focused 0.4.3 workspace release.

## 0.4.2

### Changed

- No schema or default changes shipped in this release. The version bump keeps the protocol package aligned with the 0.4.2 workspace release.

## 0.4.1

### Changed

- No schema or default changes shipped in this release. The version bump keeps the protocol package aligned with the 0.4.1 workspace release.

## 0.4.0

### Changed

- Added shared helpers to extract request ids from `reqId`, `requestId`, and nested `request.requestId` payload shapes, plus normalized network-response summaries for downstream consumers.
- Added shared HTML blob MIME and file-extension mapping so archive producers and readers can round-trip `text/html` snapshot blobs consistently.

## 0.3.0

### Changed

- No schema or default changes shipped in this release. The version bump keeps the protocol package aligned with the extension-focused 0.3.0 workspace release.

## 0.2.0

### Changed

- No schema or default changes in this release. The version bump keeps the protocol package aligned with the 0.2.0 workspace release.

## 0.1.3

### Changed

- No schema or default changes in this release. The version bump keeps the protocol package aligned with the 0.1.3 workspace release.

## 0.1.2

### Changed

- Refreshed the package README to better document the shared event schema, defaults, and export policy types.

## 0.1.1

### Changed

- No schema or default changes in this release. The version bump kept the protocol package aligned with the post-0.1.0 workspace release.

## 0.1.0

### Added

- Initial shared protocol release with archive manifests, event types, recorder defaults, and export/redaction policy definitions.
