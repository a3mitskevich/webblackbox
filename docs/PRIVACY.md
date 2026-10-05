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
- `Full capture`: everything above plus input values and keys, storage values, the raw DOM (the page HTML), all textual bodies up to 1 MiB, optional tab video and 60 Hz pointer sampling, **recorded raw**: content masking is off and no blocked selectors are kept.
- The other presets do not record the raw DOM; a duplicated profile can set `dom` to `allow`.
- Any profile can be deleted, the `Default` profile and the presets included; "Restore recommended profiles" in Options brings back the deleted ones. Recording needs at least one profile: with none left, the popup asks for one and links to Options → Profiles. Profiles from the enterprise policy (`managed:*`) cannot be deleted by the user. Site rules that point at a deleted profile are kept, flagged in Options, and skipped until the profile exists again.

## Redaction Rules

Each profile carries its redaction rules (Options → Profiles):

- **Mask captured content** (master switch, on by default). Off records captured content as-is wherever the categories allow it: bodies, headers and cookies, URLs with their queries, the raw DOM, storage values, input values and keys (password fields included), console and exception text, WebSocket/SSE payloads, and selectors; no keyed hashing. Categories still decide what is captured at all. A profile with masking off is extended (below), and the archive is encrypted like every archive.
- **Built-in heuristics** (on by default): an optional rule set, not a guarantee and not extended over time. It strips URL queries and fragments and templates ids in URL paths, masks headers named like credentials, masks storage values whose key or content mentions a secret name or holds a credential-shaped token, never records secret- or card-named fields, and sanitizes the raw DOM fail closed (scripts, comments, handlers and inline documents removed; URL queries, credentials and credential-shaped tokens stripped from every attribute value, text node and style text; suspicious style text dropped whole).
- **Your rules**: blocked selectors (masked elements), unmask selectors, header names, cookie names, JSON/form body keys, URL query parameter names, storage keys, and value patterns (`[bodies, dom, storage, inputs, console, urls] regex`, one per line). Value patterns run in a linear-time engine; backreferences and lookarounds are rejected when the profile is saved.
- While masking is on, password, one-time-code and payment card fields are never recorded (fields that are or were `type="password"`, password-like names, `current-password`, `new-password`, `one-time-code` and `cc-*` autocomplete fields). The development build watches for revealed password fields from page load; the store-safe build injects its content script on Start, so a field revealed before Start is caught only by its name or autocomplete. Values of fields inside `blockedSelectors` are not recorded unless an unmask selector at least as close to the field re-allows them; unmask selectors never expose password fields.
- The redaction sandbox in Options applies the same functions as capture, so a profile's rules can be tested on pasted samples.

Profiles above the standard Full ceiling, with any unmask selector, or with masking off are marked **extended** in the popup and Options. The mark is informational:

- A profile runs as chosen on every host. (Earlier builds limited extended profiles to hosts named by their rules and ran them as `Full` elsewhere; the Player still flags such archives.)
- Site rules only pick a profile; recording always starts manually.
- A recording keeps the profile it started with. If the effective profile changes after Start (on navigation the site rules pick another profile, the profile is deleted or edited, or the enterprise policy changes what it may record), the recording is stopped. Rules that read the page title, meta tags or selectors are checked once the new page has loaded. What was captured until then is kept for export or deletion, the archive records the reason (`meta.config.profileCancel`), the toolbar badge shows `!`, and the popup says what changed and how to fix it (choose the profile explicitly instead of `Auto`, add a site rule, or start a new recording). The Player shows a banner for such archives.
- Enterprise `dataCategoryCaps` remain a ceiling for every profile. The popup names the capped categories before Start, and the archive records them (`profile.enterpriseCapped`).

## Local Storage

Captured sessions remain local until the user exports or shares an archive. Local stopped sessions are subject to retention controls, and enterprise policies can cap local retention.

## Export And Share

Every archive is encrypted before it leaves the extension or the SDK; the pipeline refuses to write one without a passphrase of at least 8 characters (surrounding whitespace is not part of it), whatever the profile. The archive's plaintext `manifest.json` holds only what decryption needs (the format version and the encryption parameters); the site, mode, statistics and redaction rules are in the encrypted `meta/manifest.json`. The Player, the MCP server and the SDK ask for the passphrase and still open older (format 1) archives. Known gaps: the zip directory still shows how many event chunks and blobs an archive holds and the blobs' content hashes, and local session data in the browser's IndexedDB is not encrypted at rest by default.

The privacy scanner runs on every export and only warns: its findings are shown next to the export result, never blocking it. The public share server stores encrypted archive bytes and redacted public metadata, rejects plaintext uploads, and rejects encrypted uploads that leave private archive files (event chunks, blobs, indexes, privacy or full manifests) in plaintext. It never receives archive passphrases or decryption keys.

Public share links expire, can be revoked, and generate redacted audit events. Audit records do not include captured payloads, passphrases, API keys, raw URLs, raw selectors, or archive plaintext.

## Deletion

Deleting a local session removes local indexes, chunks, blobs, annotations, and object URLs. Revoking a share blocks future access. Expired share records and archive bytes are pruned according to the configured retention window.

## Telemetry And Logs

Operational logs and audit logs must not contain captured payloads, raw URLs, raw selectors, consent PII, passphrases, derived keys, archive plaintext, URL fragments, or selector hash keys.
