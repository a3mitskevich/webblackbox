# @webblackbox/recorder

## 0.7.0

### Minor Changes

- Added `WebBlackboxRecorder.reconfigure`/`getConfig`, the optional `RecorderHooks.shouldKeepInlineNetworkBody` hook, and the `DefaultEventNormalizer` `consoleDetail` option.
- Normalized the new pointer, tabs-context, and script-symbolication raw events (`user.pointerdown/up`, `user.contextmenu`, `user.auxclick`, `user.click.reaction`, `user.drag.start/end`, `user.selection`, `user.wheel`, `user.hover`, `meta.tabs.snapshot/change`, `sys.script`, `network.body.skipped`).
- CDP `Network.*` payloads are now projected onto an explicit field allowlist, and inline network bodies are gated behind the new hook; non-allowlisted fields (raw headers, `securityDetails`, remote addresses, base64 bodies) are no longer recorded.
- Under `console: allow` the recorder keeps the full console text (up to 64 KiB with a `truncated` flag) and complete stacks instead of truncating to ~600 characters.
- Hashed redaction values now use a per-session keyed HMAC instead of plain SHA-256, so hash outputs differ from previous releases and across sessions.

### Patch Changes

- Updated dependencies
  - @webblackbox/protocol@0.7.0

## 0.6.0

### Minor Changes

- Normalized `screen.recording.*` raw events into protocol events.
- Classified screen recordings as high-sensitivity capture data and enforced the `screenRecordings` capture-policy gate.

### Patch Changes

- Updated dependencies
  - @webblackbox/protocol@0.6.0

## 0.5.0

### Minor Changes

- Rolled up the post-0.4.5 capture-policy work: recorder events now carry privacy classification metadata and capture adapters receive policy context before emitting sensitive categories.
- Sanitized URLs and target selectors earlier in the recorder path and added coverage for capture-policy gates.

### Patch Changes

- Updated dependencies
  - @webblackbox/protocol@0.5.0

## 0.4.5

### Patch Changes

- No recorder runtime changes shipped in this release. The version bump keeps the package aligned with the broader 0.4.5 capture performance and redaction-default updates.
- Updated dependencies
  - @webblackbox/protocol@0.4.5

## 0.4.4

### Patch Changes

- No recorder runtime changes shipped in this release. The version bump keeps the recorder package aligned with the Player timeline and marker fixes in the 0.4.4 workspace release.
- Updated dependencies
  - @webblackbox/protocol@0.4.4

## 0.4.3

### Changed

- No package-specific runtime changes shipped in this release. The version bump keeps the recorder package aligned with the extension-focused 0.4.3 workspace release.

## 0.4.2

### Changed

- No package-specific runtime changes shipped in this release. The version bump keeps the recorder package aligned with the 0.4.2 workspace release.

## 0.4.1

### Changed

- No package-specific runtime changes shipped in this release. The version bump keeps the recorder package aligned with the 0.4.1 workspace release.

## 0.4.0

### Changed

- Normalized request-id extraction through the shared protocol helpers so action-span tracking and content-event normalization accept `reqId`, `requestId`, and nested `request.requestId` consistently.
- Backfilled `ref.req` on action-linked events when request ids are only present in payload data, keeping downstream request/action association stable.

## 0.3.0

### Changed

- No package-specific runtime changes shipped in this release. The version bump keeps the recorder package aligned with the extension-focused 0.3.0 workspace release.

## 0.2.0

### Changed

- No package-specific runtime changes in this release. The version bump keeps the recorder package aligned with the 0.2.0 workspace release.

## 0.1.3

### Changed

- No package-specific runtime changes in this release. The version bump keeps the recorder package aligned with the 0.1.3 workspace release.

## 0.1.2

### Changed

- Refreshed the package README to better document recorder configuration, freeze policy, and export responsibilities.

## 0.1.1

### Changed

- No package-specific source changes in this release. The version bump kept the recorder package aligned with the post-0.1.0 workspace release.

## 0.1.0

### Added

- Initial recorder package with ring-buffer capture management, freeze-policy evaluation, redaction helpers, and export orchestration.
