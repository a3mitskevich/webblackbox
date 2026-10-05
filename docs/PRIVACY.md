# WebBlackbox Privacy Model

WebBlackbox is a browser debugging recorder. The privacy model has two parts:

1. **What is captured** is decided by the recording profile's categories (`off`, `metadata`, `allow`…). This is the control that matters: data a category does not capture is never recorded.
2. **What is masked** inside captured content follows redaction rules the user owns. Masking applies your rules on a best-effort basis; WebBlackbox does not guarantee that all sensitive data is removed.

What WebBlackbox does guarantee is that **every exported archive is encrypted** (AES-GCM, PBKDF2-derived key, passphrase of at least 8 characters). There is no plaintext export.

## Default Collection

By default, WebBlackbox records metadata needed to debug a session:

- user action metadata, not raw typed values
- network method, status, type, timing, and sanitized URL shape
- console metadata, not raw free-form payloads
- storage counts, not values or key names
- privacy provenance and scanner results

By default, WebBlackbox does not collect raw input values, DOM text, screenshots, storage values, cookies, raw headers, request bodies, or response bodies.

## Recording Profiles

What the extension records is decided by the recording profile in effect. The `Default` profile keeps the defaults above unchanged; read-only presets raise them:

- `Lite` / `Full`: the defaults above on each transport (Full adds CDP screenshots).
- `QA`: console text, JSON/text/form/XML/GraphQL bodies up to 256 KiB, screenshots. Content masking stays on (QA debugs real sites with the default rules).
- `Full capture`: everything above plus input values and keys, storage values, all textual bodies up to 1 MiB, optional tab video and 60 Hz pointer sampling, **recorded raw**: content masking is off and no blocked selectors are kept.
- No preset records the raw DOM (the page HTML). It stays opt-in: duplicate a preset and set `dom` to `allow`.

## Redaction Rules

Each profile carries its redaction rules (Options → Profiles):

- **Mask captured content** (master switch, on by default). Off records captured content as-is wherever the categories allow it: bodies, headers and cookies, URLs with their queries, the raw DOM, storage values, input values and keys (password fields included), console and exception text, WebSocket/SSE payloads, and selectors; no keyed hashing. Categories still decide what is captured at all. A profile with masking off is extended (below), and the archive is encrypted like every archive.
- **Built-in heuristics** (on by default): an optional rule set, not a guarantee and not extended over time. It strips URL queries and fragments and templates ids in URL paths, masks headers named like credentials, masks storage values whose key or content mentions a secret name or holds a credential-shaped token, never records secret- or card-named fields, and sanitizes the raw DOM fail closed (scripts, comments, handlers and inline documents removed; URL queries, credentials and credential-shaped tokens stripped from every attribute value, text node and style text; suspicious style text dropped whole).
- **Your rules**: blocked selectors (masked elements), unmask selectors, header names, cookie names, JSON/form body keys, URL query parameter names, storage keys, and value patterns (`[bodies, dom, storage, inputs, console, urls] regex`, one per line). Value patterns run in a linear-time engine; backreferences and lookarounds are rejected when the profile is saved.
- While masking is on, password, one-time-code and payment card fields are never recorded (fields that are or were `type="password"`, password-like names, `current-password`, `new-password`, `one-time-code` and `cc-*` autocomplete fields). The development build watches for revealed password fields from page load; the store-safe build injects its content script on Start, so a field revealed before Start is caught only by its name or autocomplete. Values of fields inside `blockedSelectors` are not recorded unless an unmask selector at least as close to the field re-allows them; unmask selectors never expose password fields.
- The redaction sandbox in Options applies the same functions as capture, so a profile's rules can be tested on pasted samples.

Profiles above the standard Full ceiling, with any unmask selector, or with masking off are **extended**:

- Extended profiles only run on hosts named by a site rule that selects them, by the profile store's extended-capture host list, or by the enterprise site allowlist. Elsewhere the profile runs at the Full preset levels with masking on: nothing it turned down is turned back on, unmask selectors are dropped, a profile that had masking off gets the Full preset's rules, and the archive records the downgrade. Leaving an allowed host applies the downgrade at once, before the page is probed for DOM-based rules.
- Site rules only pick a profile; recording always starts manually.
- Enterprise `dataCategoryCaps` remain a ceiling for every profile.

## Local Storage

Captured sessions remain local until the user exports or shares an archive. **Unexported recordings are cleared when the browser restarts.**

Everything the extension writes to its IndexedDB (event chunks, blobs such as screenshots, video and bodies, indexes, integrity manifests and session metadata like the URL, title and tags) is encrypted with AES-256-GCM. Storage can be swept without decrypting it, so some bookkeeping stays readable: opaque session and chunk ids, the tab id, the capture mode, timestamps, event counts and byte sizes, blob MIME types, and SHA-256 hashes of chunk and blob contents (blobs are deduplicated by content hash). A hash reveals nothing on its own, but someone holding a copy of a file could confirm that the same file was recorded.

- **Key per browser session.** The service worker generates a random key the first time it runs in a browser session and keeps it only in `chrome.storage.session`. Chrome holds that area in memory and clears it when the browser exits or the extension reloads; it is never written to disk. Its access level stays at `TRUSTED_CONTEXTS` (set explicitly), so content scripts cannot read it.
- **Trade-off.** A `CryptoKey` cannot be stored in `chrome.storage.session` or sent over extension messaging (both are JSON), and offscreen documents have no `chrome.storage`. So the raw key bytes live in `chrome.storage.session` and are sent to the offscreen document, and only to it (the port's sender must be the offscreen page, not a tab). The offscreen document imports them as a non-extractable key and zeroes its copy. The raw key exists in browser memory for the browser session, never on disk.
- **Restart purge.** When the service worker finds no key (a new browser session or an extension reload), it deletes the pipeline database before anything opens it, and it wakes on browser startup to do so right away. Recordings left from before are unrecoverable by design. A worker restart within the same browser session (Chrome stops idle workers) keeps the key and the recordings. The offscreen document also deletes any stored session its key cannot decrypt, including plaintext rows written by builds before this one.
- **Retention.** Each profile decides whether a recording is deleted after a successful export (default: yes, as before) and how long a stopped, unexported recording is kept (default 10 minutes; Full capture 5 minutes; 1 to 1440). A stopped recording stays listed and exportable for that time, even across service worker restarts: each stop flushes the recording to the encrypted store and leaves a snapshot (URL, title, profile and recorder settings) in `chrome.storage.session`, from which a new worker rebuilds the session. Its deletion is a `chrome.alarms` alarm, which fires even if Chrome stopped the worker in between; expired recordings are also deleted when a worker starts. Either way, nothing outlives the browser session. Session tags and notes are kept in `chrome.storage.session` too.

The lite SDK can encrypt its own storage with `pipelineStorageEncryptionKey`; with a key, session metadata and indexes are encrypted as well.

## Export And Share

Every archive is encrypted before it leaves the extension or the SDK; the pipeline refuses to write one without a passphrase of at least 8 characters (surrounding whitespace is not part of it), whatever the profile. The archive's plaintext `manifest.json` holds only what decryption needs (the format version and the encryption parameters); the site, mode, statistics and redaction rules are in the encrypted `meta/manifest.json`. The Player, the MCP server and the SDK ask for the passphrase and still open older (format 1) archives. Known gaps: the zip directory still shows how many event chunks and blobs an archive holds and the blobs' content hashes.

The privacy scanner runs on every export and only warns: its findings are shown next to the export result, never blocking it. The public share server stores encrypted archive bytes and redacted public metadata, rejects plaintext uploads, and rejects encrypted uploads that leave private archive files (event chunks, blobs, indexes, privacy or full manifests) in plaintext. It never receives archive passphrases or decryption keys.

Public share links expire, can be revoked, and generate redacted audit events. Audit records do not include captured payloads, passphrases, API keys, raw URLs, raw selectors, or archive plaintext.

## Deletion

Deleting a local session removes local indexes, chunks, blobs, annotations, and object URLs. Revoking a share blocks future access. Expired share records and archive bytes are pruned according to the configured retention window.

## Telemetry And Logs

Operational logs and audit logs must not contain captured payloads, raw URLs, raw selectors, consent PII, passphrases, derived keys, archive plaintext, URL fragments, or selector hash keys.
