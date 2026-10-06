# @webblackbox/share-server

## 0.7.0

### Minor Changes

- Plaintext uploads are now always rejected and the `WEBBLACKBOX_SHARE_ALLOW_PLAINTEXT_UPLOADS` switch is removed; self-hosters who enabled it must export encrypted archives instead.
- Hardened trust boundaries: `WEBBLACKBOX_TRUSTED_PROXIES` CIDR parsing with right-most-untrusted-hop forwarded-header resolution, a `WEBBLACKBOX_SHARE_ALLOWED_HOSTS` Host allowlist, and rejection of forwarding headers in keyless loopback mode.
- Archive analysis now runs in a heap- and time-limited worker thread with `WEBBLACKBOX_SHARE_MAX_UNCOMPRESSED_BYTES`, `WEBBLACKBOX_SHARE_ANALYSIS_TIMEOUT_MS`, `WEBBLACKBOX_SHARE_MAX_HEAP_MB`, and `WEBBLACKBOX_SHARE_CONCURRENCY`; oversized archives get a 413.

### Patch Changes

- Audit events are written before the share response is sent.
- Updated dependencies
  - @webblackbox/player-sdk@0.7.0

## 0.6.0

### Minor Changes

- No share-server runtime changes shipped in this release. The version bump keeps hosted sharing aligned with Player SDK 0.6.0 archive metadata support.

### Patch Changes

- Updated dependencies
  - @webblackbox/player-sdk@0.6.0

## 0.5.0

### Minor Changes

- Rolled up the post-0.4.5 secure sharing flow: public uploads now require encrypted archives, privacy preflight review, scoped API keys, expiry/revocation controls, and audit coverage.
- Hardened upload validation by rejecting plaintext archive content, encrypted archive files uploaded as plaintext blobs, and query-string API key propagation while returning client errors for oversized uploads.

### Patch Changes

- Updated dependencies
  - @webblackbox/player-sdk@0.5.0

## 0.4.5

### Patch Changes

- Added privacy protection reports and bounded sensitive-data previews to generated share summaries.
- Updated dependencies
  - @webblackbox/player-sdk@0.4.5

## 0.4.4

### Patch Changes

- No share-server runtime changes shipped in this release. The version bump keeps the share server aligned with the Player timeline and marker fixes in the 0.4.4 workspace release.
- Updated dependencies
  - @webblackbox/player-sdk@0.4.4

## 0.4.3

### Changed

- No package-specific runtime changes shipped in this release. The version bump keeps the share server aligned with the extension-focused 0.4.3 workspace release.

## 0.4.2

### Changed

- No package-specific runtime changes shipped in this release. The version bump keeps the share server aligned with the 0.4.2 workspace release.

## 0.4.1

### Changed

- No package-specific runtime changes shipped in this release. The version bump keeps the share server aligned with the 0.4.1 workspace release.

## 0.4.0

### Changed

- No package-specific source changes shipped in this release.
- Picked up `@webblackbox/player-sdk` 0.4.0, so uploaded archives are analyzed with integrity verification on read and more consistent request/action correlation in generated summaries.

## 0.3.0

### Changed

- No package-specific runtime changes shipped in this release. The version bump keeps the share server aligned with the extension-focused 0.3.0 workspace release.

## 0.2.0

### Changed

- No package-specific runtime changes in this release. The version bump keeps the share server aligned with the 0.2.0 workspace release.

## 0.1.3

### Changed

- No package-specific runtime changes in this release. The version bump keeps the share server aligned with the 0.1.3 workspace release.

## 0.1.2

### Changed

- No package-specific runtime changes in this release. The version bump kept the share server aligned with the rest of the workspace.

## 0.1.1

### Changed

- No package-specific runtime changes in this release. The version bump kept the share server aligned with the post-0.1.0 workspace release.

## 0.1.0

### Added

- Initial share-server release with archive upload, listing, metadata, download, and browser share-link endpoints.
- Included configurable API-key, origin, retention, and upload-limit hooks for self-hosted collaboration workflows.
