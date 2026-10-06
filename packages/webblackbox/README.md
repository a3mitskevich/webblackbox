<p align="center">
  <a href="https://github.com/a3mitskevich/webblackbox"><img src="https://raw.githubusercontent.com/a3mitskevich/webblackbox/main/logo.png" alt="WebBlackbox" width="80" /></a>
</p>

<h1 align="center">webblackbox</h1>

<p align="center">
  Browser-side lite capture SDK — record, export, and embed WebBlackbox sessions in any web app.
</p>

<p align="center">
  <a href="https://github.com/a3mitskevich/webblackbox/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-374151" alt="License" /></a>
  <a href="https://github.com/a3mitskevich/webblackbox"><img src="https://img.shields.io/badge/Part%20of-WebBlackbox-000?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiByeD0iMyIgZmlsbD0iIzFhMWEyZSIvPjxwYXRoIGQ9Ik0zIDhoMi41bDIuNS00TDEwLjUgMTIgMTMgOCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZjk3MzE2IiBzdHJva2Utd2lkdGg9IjEuNSIvPjwvc3ZnPg==" alt="WebBlackbox" /></a>
</p>

---

The browser-side lite capture SDK for [WebBlackbox](https://github.com/a3mitskevich/webblackbox). Embed session recording directly in your web application — no Chrome extension required. Captures user interactions, console logs, network requests, DOM mutations, storage operations, and opt-in screenshots, then exports portable, always-encrypted `.webblackbox` archives (format 2) that the Player in this repository opens.

## Installation

This fork does not publish `webblackbox` to npm. Depend on it from this pnpm workspace (`"webblackbox": "workspace:*"`)
or build it from source with `pnpm --filter webblackbox build` and use `packages/webblackbox/dist`.

## Quick Start

```ts
import { WebBlackboxLiteSdk } from "webblackbox/lite-sdk";

const sdk = new WebBlackboxLiteSdk({
  showIndicator: true,
  storage: "memory"
});

await sdk.start();

// ... user interacts with the page ...

// Every archive is encrypted: export() throws without a passphrase of at least 8 characters.
const exported = await sdk.export({ passphrase: "correct horse battery", stopCapture: true });
sdk.downloadArchive(exported);
await sdk.dispose();
```

Other instance members: `stop()`, `flush()`, `emitMarker(message)`, `ingestRawEvent()` / `ingestRawEvents()`,
`getSessionMetadata()`, `getRecorderConfig()`, `sessionId`, `isRecording`, and the static
`WebBlackboxLiteSdk.downloadArchive(result)`.

## What Gets Recorded

The SDK uses `DEFAULT_CAPTURE_POLICY` from `@webblackbox/protocol` unless you pass
`config.capturePolicy`. Its categories decide how much detail survives:

- **Console** — under the default `console: "metadata"`, entries keep only method and level, and
  page errors only their location (`messageRedacted` / `stackRedacted`). Under `"allow"`, the text and
  arguments are kept in full up to 64 KiB per entry (`truncated: true` past that), and
  `console.error` / `warn` / `assert` / `trace` carry the caller's stack (up to 200 frames).
  `"off"` drops them and records a `privacy.violation` instead.
- **Keystrokes** — navigation and editing keys (Enter, Tab, Escape, arrows, F1–F24, …) are always
  kept. In a password field or an element covered by a blocked selector, any other key is replaced
  with `[REDACTED]` (and `code` dropped) whatever `inputs` says, as long as content masking
  (`redaction.contentRedaction`) is on, which is the default. In other editable fields
  (text inputs, textareas, selects, contenteditable), typed keys are redacted too, except
  Ctrl/Cmd shortcuts, unless `inputs: "allow"`.
- **Pointer** — clicks, presses (`user.pointerdown` / `user.pointerup`, with long press), right and
  middle clicks and click reactions are always captured. Hover, drag/selection and wheel are opt-in
  through `config.pointer`:

```ts
const sdk = new WebBlackboxLiteSdk({
  config: { pointer: { hover: true, drag: true, wheel: false } }
});
```

## What's Included

| Export                            | Description                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| `WebBlackboxLiteSdk`              | Main SDK class — start/stop/flush/export `.webblackbox` archives in-page                  |
| `LiteCaptureAgent`                | Reusable capture agent for input, DOM/storage snapshots, screenshots, and injected bridge |
| `installInjectedLiteCaptureHooks` | Runtime hooks for console/network/storage/error interception                              |
| `materializeLiteRawEvent`         | Shared lite raw-event materialization pipeline                                            |

### Entry Points

The package root (`webblackbox`) re-exports the four modules below and the types. Subpaths:

```ts
import { WebBlackboxLiteSdk } from "webblackbox/lite-sdk";
import { LiteCaptureAgent } from "webblackbox/lite-capture-agent";
import { installInjectedLiteCaptureHooks } from "webblackbox/injected-hooks";
import { materializeLiteRawEvent } from "webblackbox/lite-materializer";
import type { WebBlackboxLiteSdkOptions } from "webblackbox/types";
```

`webblackbox/capture-scope` and `webblackbox/input-value-policy` hold helpers the extension shares
with the capture agent.

## Optional IndexedDB Cache Encryption

When using `storage: "indexeddb"`, you can provide `pipelineStorageEncryptionKey` to encrypt cached chunk/blob payload bytes at rest.

```ts
import { derivePipelineStorageKey } from "@webblackbox/pipeline";
import { WebBlackboxLiteSdk } from "webblackbox/lite-sdk";

const derived = await derivePipelineStorageKey("cache-passphrase");

const sdk = new WebBlackboxLiteSdk({
  storage: "indexeddb",
  pipelineStorageEncryptionKey: derived.key
});
```

Persist `derived.salt` + `derived.iterations` using your own key-management policy if you need to reopen the same encrypted cache.

## Redaction Lists Replace the Defaults

Every list you pass in `options.config.redaction` (`blockedSelectors`, `redactHeaders`, `redactCookieNames`, `redactBodyPatterns`, `redactQueryParams`, `redactStorageKeys`, `unmaskSelectors`, `valuePatterns`) **replaces** the default list of the same name; it is not merged with it. You own the full list: `blockedSelectors: [".my-secret"]` blocks `.my-secret` only, and the default selectors such as `.secret`, `[data-sensitive]` and `[data-webblackbox-redact]` are no longer blocked. Fields you leave out keep their defaults. Password field values stay masked by the input policy while content masking (`contentRedaction`) is on, whatever the selector lists say.

To extend the defaults, spread them explicitly. They are exported as `DEFAULT_REDACTION_PROFILE` from `@webblackbox/protocol` (install it next to `webblackbox`):

```ts
import { DEFAULT_REDACTION_PROFILE } from "@webblackbox/protocol";
import { WebBlackboxLiteSdk } from "webblackbox/lite-sdk";

const sdk = new WebBlackboxLiteSdk({
  config: {
    redaction: {
      blockedSelectors: [...DEFAULT_REDACTION_PROFILE.blockedSelectors, ".my-secret"],
      redactHeaders: [...DEFAULT_REDACTION_PROFILE.redactHeaders, "x-tenant-token"]
    }
  }
});
```

The same applies to `config.capturePolicy.redaction`; `config.redaction` is applied on top of it, field by field. Masking applies your rules on a best-effort basis and does not guarantee that all sensitive data is removed.

## Default Safety Tuning

`WebBlackboxLiteSdk` applies lite-focused runtime defaults to reduce long-session freezes and archive bloat:

| Setting                  | Default | Why                                                 |
| ------------------------ | ------- | --------------------------------------------------- |
| `freezeOnError`          | `true`  | Capture uncaught JS exceptions/rejections           |
| `freezeOnNetworkFailure` | `false` | Avoid noisy freezes from transient network issues   |
| `freezeOnLongTaskSpike`  | `false` | Avoid freezes from expected long tasks              |
| `mousemoveHz`            | `14`    | Lower than the protocol default (20 Hz)             |
| `scrollHz`               | `10`    | Lower than the protocol default (15 Hz)             |
| `domFlushMs`             | `160`   | Longer than the protocol default (100 ms)           |
| `snapshotIntervalMs`     | `30000` | Longer than the protocol default (20 s)             |
| `screenshotIdleMs`       | `0`     | Disabled unless explicitly enabled                  |
| `bodyCaptureMaxBytes`    | `0`     | Disabled — keeps lite sessions page-thread friendly |

Override any of these through `options.config`.

### Export Policy Defaults

| Setting                   | Default    |
| ------------------------- | ---------- |
| `includeScreenshots`      | `false`    |
| `includeScreenRecordings` | `false`    |
| `maxArchiveBytes`         | 100 MiB    |
| `recentWindowMs`          | 20 minutes |

`export()` clamps `maxArchiveBytes` to 64 KiB–5 GiB and `recentWindowMs` to 1 minute–30 days;
a missing or non-positive value uses the default.

## Extension Reuse

The Chrome extension (`apps/extension`) reuses this package in lite capture mode:

- **Content agent** (`content-agent.js`, loaded by the content script) → `webblackbox/lite-capture-agent`
- **Injected script** → `webblackbox/injected-hooks`
- **Service worker** → `webblackbox/lite-materializer`, `webblackbox/capture-scope`
- **Content script** → `webblackbox/capture-scope`, `webblackbox/input-value-policy`

This keeps capture logic centralized and shared across the SDK and extension lite mode.

## Testing

```bash
# Unit & integration tests
pnpm --filter webblackbox test

# End-to-end full-chain verification (extension → export → player)
pnpm --filter @webblackbox/extension e2e:fullchain:lite
pnpm --filter @webblackbox/extension e2e:fullchain:lite:reload
pnpm --filter @webblackbox/extension e2e:fullchain:full
```

## License

[MIT](https://github.com/a3mitskevich/webblackbox/blob/main/LICENSE)
