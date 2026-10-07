# WebBlackbox Security Overview

## Extension Permissions

The default (`dev`) build is the one `pnpm build` and `pnpm package:chrome` produce. It requests `debugger` (CDP for the Full engine), `tabs`, `webRequest`, `webNavigation`, `tabCapture` and persistent `<all_urls>` host access. The manifest declares no static content scripts: by default the service worker registers the content script for all pages at `document_start`, and Options → Performance & sampling can switch it to injection on Start only. In both modes nothing is recorded until the user presses Start in a tab.

The store-safe build (`node scripts/build-extension.mjs --profile store-safe`) uses `activeTab` and programmatic injection after a user gesture. It does not include `debugger`, `tabs`, `webRequest`, persistent `<all_urls>` host permissions, or always-on all-sites content scripts.

## Data Flow

1. Capture adapters apply the recording profile's categories and redaction rules before data enters the recorder pipeline. Categories decide what is captured; masking applies the user's rules on a best-effort basis and can be turned off per profile (the `Full capture` preset records raw).
2. The ingest gate rejects or replaces policy-violating artifacts with `privacy.violation` events.
3. Archives include `privacy/manifest.json` (encrypted like the rest of the archive) with policy, categories, encryption status, and the scanner result.
4. The share server analyses each uploaded archive itself (encryption, which private files are encrypted) instead of trusting client-supplied metadata.

## Encryption

Every export is encrypted (AES-GCM, PBKDF2-derived key); the pipeline refuses to write an archive without a passphrase of at least 8 characters. Format-2 archives keep only a minimal envelope (`manifest.json` with the encryption parameters) and `integrity/hashes.json` in plaintext; the full manifest is in the encrypted `meta/manifest.json`. Format-1 archives remain readable.

Recordings kept in the extension are encrypted at rest (AES-256-GCM) with a random key that lives only in `chrome.storage.session` (memory, trusted contexts) for the browser session; unexported recordings are unrecoverable after the browser restarts. See [PRIVACY.md](./PRIVACY.md#local-storage).

Public share uploads must be encrypted `.webblackbox` archives and never accept passphrases. Private archive paths include event chunks, blobs, indexes, and `privacy/manifest.json`; archives with plaintext private files are rejected and must be re-exported before public sharing. Client-side share metadata is limited to an allowlisted public summary.

Source maps that a profile embeds are fetched by the extension; cookies are sent only when the map is on the script's own origin, so a page cannot make the extension send authenticated requests to other sites.

## Player Safety

The player treats archives as untrusted input. It does not load captured external resources by default, limits replay resources to inert local object/data URLs, revokes screenshot object URLs after a short TTL, and serves player/share views with no-referrer and restrictive CSP controls.

The extension has no built-in Player address: "Export and open in Player" opens only a Player URL set in Options or by enterprise policy (`https://`, or `http://` on `localhost` / `127.0.0.1`), and sends neither the archive nor its passphrase there.

## Share Server

The share server supports scoped API keys, upload rate limits, expiry, revocation, redacted metadata, and redacted audit logs. It rejects plaintext uploads whatever its configuration.

## Reporting Security Issues

Report suspected security issues privately to the project maintainers. Do not include captured customer data, passphrases, or raw archive contents in reports.
