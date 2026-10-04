# WebBlackbox Privacy Model

WebBlackbox is a browser debugging recorder. The commercial privacy baseline is local-first, minimal capture, explicit export, and encrypted sharing.

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
- `QA`: console text, JSON/text/form/XML/GraphQL bodies up to 256 KiB, screenshots.
- `Full capture`: everything above plus input values, storage values, all textual bodies up to 1 MiB, optional tab video and 60 Hz pointer sampling.
- No preset records the raw DOM (the page HTML). It stays opt-in: duplicate a preset and set `dom` to `allow`.

Profiles whose capture levels exceed the standard Full ceiling are **extended**. Safeguards:

- Extended profiles only run on hosts named by a site rule that selects them, by the profile store's extended-capture host list, or by the enterprise site allowlist. Elsewhere the profile runs at the Full preset levels instead: its own redaction lists, retention and export rules are kept, nothing it turned down is turned back on, unmask selectors are dropped, and the archive records the downgrade. Leaving an allowed host applies the downgrade at once, before the page is probed for DOM-based rules.
- Site rules only pick a profile; recording always starts manually.
- Input values are never recorded for password fields, whatever the profile says: fields that are or were `type="password"` (a "show password" toggle does not reveal them), fields whose name or id looks like a password, and `current-password`, `new-password`, `one-time-code` and payment card (`cc-number`, `cc-csc`, `cc-exp*`) autocomplete fields. The development build watches for revealed password fields from page load; the store-safe build injects its content script on Start, so a field revealed before Start is caught only by its name or autocomplete. Values are also never recorded for fields inside `blockedSelectors` unless a profile unmask selector explicitly re-allows them (an unmask selector on an ancestor does not override a nearer blocked selector; an invalid blocked selector blocks). Unmask selectors can never expose password fields, and any unmask list makes a profile extended.
- Body values after sensitive keys are still masked, and the privacy scanner still runs.
- Enterprise `dataCategoryCaps` remain a ceiling for every profile.

## Local Storage

Captured sessions remain local until the user exports or shares an archive. Local stopped sessions are subject to retention controls, and enterprise policies can cap local retention.

## Export And Share

Real-user archives must be encrypted before export or share. A session that recorded under an extended profile (or a profile that requires encryption) cannot be exported without a passphrase, and the privacy scanner blocks its export until the user reviews and acknowledges the findings. The plaintext `manifest.json` carries only the sanitized origin, never the page title. The public share server stores encrypted archive bytes and redacted public metadata. It does not receive archive passphrases or decryption keys, and it rejects encrypted uploads that leave private archive files, including event chunks, blobs, indexes, or privacy manifests, in plaintext.

Public share links expire, can be revoked, and generate redacted audit events. Audit records do not include captured payloads, passphrases, API keys, raw URLs, raw selectors, or archive plaintext.

## Deletion

Deleting a local session removes local indexes, chunks, blobs, annotations, and object URLs. Revoking a share blocks future access. Expired share records and archive bytes are pruned according to the configured retention window.

## Telemetry And Logs

Operational logs and audit logs must not contain captured payloads, raw URLs, raw selectors, consent PII, passphrases, derived keys, archive plaintext, URL fragments, or selector hash keys.
