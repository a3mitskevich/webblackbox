# WebBlackbox Privacy Model

WebBlackbox is a browser debugging recorder. The privacy model has two parts:

1. **What is captured** is decided by the recording profile's categories (`off`, `metadata`, `allow`…). This is the control that matters: data a category does not capture is never recorded.
2. **What is masked** inside captured content follows redaction rules the user owns. Masking applies your rules on a best-effort basis; WebBlackbox does not guarantee that all sensitive data is removed.

What WebBlackbox does guarantee is that **every exported archive is encrypted** (AES-GCM, PBKDF2-derived key, passphrase of at least 8 characters). There is no plaintext export.

## Default Collection

The extension records with the `Maximum` profile out of the box (see [Recording Profiles](#recording-profiles)): completeness of the recording comes first, and the archive is always encrypted. The base capture policy — what the lite SDK, the `Light` profile and profiles that keep the defaults record — captures only the metadata needed to debug a session:

- user action metadata, not raw typed values
- other tabs of the recorded site that are open in parallel: tab and window ids, origin, same-origin/same-site relation, active/focused/incognito/discarded flags and timestamps, not their paths or titles
- network method, status, type, timing, and sanitized URL shape
- console metadata, not raw free-form payloads
- storage counts, not values or key names
- privacy provenance and scanner results

The base policy does not collect raw input values, storage values, cookies, raw headers, request bodies, or response bodies. Screenshots are off in the Lite engine; the Full engine takes them unless the profile's visual capture is set to none. The Lite engine records no DOM text; the Full engine records the page DOM (snapshots and changes) at the default `dom` level, masked by the profile's rules: blocked selectors are left out, content masking applies to the text and attributes, and field values are never written unless the profile records input values.

Nothing is recorded until the user presses `Record` in a tab: no profile or site rule starts a recording.

## Recording Profiles

What the extension records is decided by the recording profile in effect: the default profile (`Maximum` unless the user picks another one in Options) or the profile a site rule picks for the page. There are two read-only built-in profiles:

- `Maximum` (the default): console text with stacks, all textual bodies up to 1 MiB, input values and keys, storage values, cookie values (HttpOnly included), IndexedDB records, the raw DOM (the page HTML), screenshots and the tab video, 60 Hz pointer sampling, paths and titles of other tabs of the site and embedded source maps, **recorded raw**: content masking is off and no blocked selectors are kept. The archive is always encrypted.
- `Light`: the defaults above on the Lite transport (page-side signals, no debugger).
- Earlier versions also had `Default`, `Full`, `QA` and `Full capture`. A one-time migration (settings version 2) points every reference to them (the default selection, site rules, managed rules, imported profile files) at `Maximum`; a `Default` profile the user had customised is kept as a user profile named `Default (custom)`, and other user profiles are kept as they are (one chosen as the default stays the default).
- Source maps: in the Full engine a profile records each script's source map reference unless it turns source maps off; `Maximum` also embeds the maps in the archive. To embed a map the extension fetches it itself, sending cookies only when the map is on the script's own origin.
- In the Full engine the page DOM is recorded at the default `dom` level (`masked`) the same way as at `allow`, through the masking rules of the profile; `wireframe` and `off` keep it out. The Lite engine records the DOM only at `allow`.
- Any profile can be deleted, the built-in ones included; "Restore recommended profiles" in Options brings back the deleted built-ins. Recording needs at least one profile: with none left, the popup asks for one and links to Options → Profiles. Profiles from the enterprise policy (`managed:*`) cannot be deleted by the user. Site rules that point at a deleted profile are kept, flagged in Options, and skipped until the profile exists again.

## Parallel Tabs

Many bugs come from several tabs of one site (shared storage and cookies, a logout in another tab, session conflicts, BroadcastChannel, a shared service worker). The `tabsContext` category records the other tabs of the recorded site: a snapshot when recording starts and every change while it runs (opened, navigated onto or off the site, navigated within it, activated or deactivated, closed).

- `off`: nothing. `metadata` (Light and the base policy): ids, origin, relation, flags and timestamps. `allow` (Maximum): also each tab's path and query and its title. `allow` makes a user profile extended.
- Paths go through the profile's URL rules (with the built-in heuristics: no query, ids templated) and titles through its `dom` value patterns and credential masking; with masking off both are recorded as-is.
- Tabs of other sites are never recorded, not even their URL when a related tab navigates away (the change keeps the tab's last state on the site). The recorded tab itself is not listed.
- "Same site" is the registrable domain (eTLD+1) without the full Public Suffix List: the last two labels, or three under a country second level (`co.uk`, `com.au`) or a listed hosting suffix (`github.io`, `vercel.app`, ...). Ports and schemes do not matter; IP addresses and single-label hosts such as `localhost` only match themselves. A host under a multi-label suffix missing from the list is grouped too broadly; its origin still shows.
- The extension listens to tab events only while a session records tabs, and collapses bursts (250 ms) instead of polling.

## Redaction Rules

Each profile carries its redaction rules (Options → Profiles):

- **Mask captured content** (master switch, on by default). Off records captured content as-is wherever the categories allow it: bodies, headers and cookies, URLs with their queries, the raw DOM, storage values, input values and keys (password fields included), console and exception text, WebSocket/SSE payloads, and selectors; no keyed hashing. Categories still decide what is captured at all. A profile with masking off is extended (below), and the archive is encrypted like every archive.
- **Built-in heuristics** (on by default): an optional rule set, not a guarantee and not extended over time. It strips URL queries and fragments and templates ids in URL paths, masks headers named like credentials, masks storage values whose key or content mentions a secret name or holds a credential-shaped token, never records secret- or card-named fields, and sanitizes the raw DOM fail closed (scripts, comments, handlers and inline documents removed; URL queries, credentials and credential-shaped tokens stripped from every attribute value, text node and style text; suspicious style text dropped whole).
- **Your rules**: blocked selectors (masked elements), unmask selectors, header names, cookie names, JSON/form body keys, URL query parameter names, storage keys, and value patterns (`[bodies, dom, storage, inputs, console, urls] regex`, one per line). Value patterns run in a linear-time engine; backreferences and lookarounds are rejected when the profile is saved.
- While masking is on, password, one-time-code and payment card fields are never recorded (fields that are or were `type="password"`, password-like names, `current-password`, `new-password`, `one-time-code` and `cc-*` autocomplete fields). With page injection set to "Always" (the default) the content script watches for revealed password fields from page load; with "Only when recording starts", and always in the store-safe build, it is injected on Start, so a field revealed before Start is caught only by its name or autocomplete. Values of fields inside `blockedSelectors` are not recorded unless an unmask selector at least as close to the field re-allows them; unmask selectors never expose password fields.
- The redaction sandbox in Options applies the same functions as capture, so a profile's rules can be tested on pasted samples.

Profiles above the standard Full ceiling, with any unmask selector, or with masking off are marked **extended** in the popup and Options. The mark is informational:

- A profile runs as chosen on every host. (Earlier builds limited extended profiles to hosts named by their rules and ran them as `Full` elsewhere; the Player still flags such archives.)
- Site rules only pick a profile; recording always starts manually.
- A recording keeps the profile it started with. If the effective profile changes after Start (on navigation the site rules pick another profile, the profile is deleted or edited, or the enterprise policy changes what it may record), the recording is stopped. Rules that read the page title, meta tags or selectors are checked once the new page has loaded. What was captured until then is kept for export or deletion, the archive records the reason (`meta.config.profileCancel`), the toolbar badge shows `!`, and the popup says what changed and how to fix it (change the default profile or a site rule in Options, or start a new recording). The Player shows a banner for such archives.
- Enterprise `dataCategoryCaps` remain a ceiling for every profile. The popup names the capped categories before Start, and the archive records them (`profile.enterpriseCapped`).

## Full → Light Fallback

A profile in the Full engine needs the debugger. When the debugger cannot run or stops, the recording goes on with page-side (Light) capture instead of ending, and nothing is hidden about it:

- Triggers: a page the debugger may not attach to (`chrome://`, `chrome-extension://`, `devtools://`, `view-source:`, `about:` pages other than `about:blank` / `about:srcdoc`, the Chrome Web Store) records in Light from the start; a failed `chrome.debugger.attach`, `Cancel` on Chrome's "started debugging this browser" bar, a debugged page that went away while the tab stayed, or any other detach switches a running recording to Light. A tab that was closed simply stops its recording.
- From then on response bodies, the full console with stacks, screenshots and DevTools data are no longer captured; page-side signals, the browser-side network baseline and (unless the page was restricted) the tab video go on.
- The toolbar badge shows `LITE`, the popup explains why and what is missing, and a notification does the same while the popup is closed.
- The archive records the detach (`sys.debugger.detach` with Chrome's reason) and a `meta.config` with `captureFallback` (`at`, `reason`, `from`, `to`, `detail`). The completeness report (`completeness.captureFallback`), the Player banner and the MCP session summary show it.
- A tab video that cannot start no longer blocks recording: the recording goes on without it and the archive says so (`sys.notice` with code `screen-recording-failed`).

## Local Storage

Captured sessions remain local until the user exports or shares an archive. **Unexported recordings are cleared when the browser restarts.**

Everything the extension writes to its IndexedDB (event chunks, blobs such as screenshots, video and bodies, indexes, integrity manifests and session metadata like the URL, title and tags) is encrypted with AES-256-GCM. Storage can be swept without decrypting it, so some bookkeeping stays readable: opaque session and chunk ids, the tab id, the capture mode, timestamps, event counts and byte sizes, blob MIME types, and SHA-256 hashes of chunk and blob contents (blobs are deduplicated by content hash). A hash reveals nothing on its own, but someone holding a copy of a file could confirm that the same file was recorded.

- **Key per browser session.** The service worker generates a random key the first time it runs in a browser session and keeps it only in `chrome.storage.session`. Chrome holds that area in memory and clears it when the browser exits or the extension reloads; it is never written to disk. Its access level stays at `TRUSTED_CONTEXTS` (set explicitly), so content scripts cannot read it.
- **Trade-off.** A `CryptoKey` cannot be stored in `chrome.storage.session` or sent over extension messaging (both are JSON), and offscreen documents have no `chrome.storage`. So the raw key bytes live in `chrome.storage.session` and are sent to the offscreen document, and only to it (the port's sender must be the offscreen page, not a tab). The offscreen document imports them as a non-extractable key and zeroes its copy. The raw key exists in browser memory for the browser session, never on disk.
- **Restart purge.** When the service worker finds no key (a new browser session or an extension reload), it deletes the pipeline database before anything opens it, and it wakes on browser startup to do so right away. Recordings left from before are unrecoverable by design. A worker restart within the same browser session (Chrome stops idle workers) keeps the key and the recordings. The offscreen document also deletes any stored session its key cannot decrypt, including plaintext rows written by builds before this one.
- **Retention.** Each profile decides whether a recording is deleted after a successful export (default: yes) and whether a stopped, unexported recording is deleted after a set time (1 to 1440 minutes). By default, and in both built-in profiles, it is kept until the user exports or deletes it — within the lifetime of the at-rest key, so never past the browser session; a local retention below the 24-hour default in the capture policy (set by an administrator or carried over from v1 options) still caps it. Right after Stop the popup offers the export (`Export archive` / `Later`), the toolbar badge shows `SAVE` while a stopped recording waits for its export, and with the popup closed a notification opens the Sessions page on that recording's export. A stopped recording stays listed and exportable, even across service worker restarts: each stop flushes the recording to the encrypted store and leaves a snapshot (URL, title, profile and recorder settings) in `chrome.storage.session`, from which a new worker rebuilds the session. A running recording keeps the same snapshot there (refreshed at most every 10 seconds); if Chrome stops the worker mid-recording, the next worker keeps that recording as an _interrupted_ one — listed with a badge, exportable, with the same retention and export prompt as a recording stopped at its last snapshot — instead of deleting it. A timed deletion is a `chrome.alarms` alarm, which fires even if Chrome stopped the worker in between; expired recordings are also deleted when a worker starts. A deletion that fails is retried twice, five minutes apart; after that the recording is left, still encrypted, until the browser closes. Either way, nothing outlives the browser session. Session tags and notes are kept in `chrome.storage.session` too.

The lite SDK can encrypt its own storage with `pipelineStorageEncryptionKey`; with a key, session metadata and indexes are encrypted as well.

## Export And Share

Every archive is encrypted before it leaves the extension or the SDK; the pipeline refuses to write one without a passphrase of at least 8 characters (surrounding whitespace is not part of it), whatever the profile. The extension asks for the passphrase on the first export of a browser session and remembers it until the browser closes: the service worker keeps it in memory and in `chrome.storage.session` (memory-backed, `TRUSTED_CONTEXTS` only, so content scripts cannot read it), never on disk and never in an archive. Later exports reuse it; `Forget passphrase` in the popup or on the Sessions page drops it. The archive's plaintext `manifest.json` holds only what decryption needs (the format version and the encryption parameters); the site, mode, statistics and redaction rules are in the encrypted `meta/manifest.json`. The archive format is 2; the Player, the MCP server and the SDK ask for the passphrase and still open older (format 1) archives. Known gaps: the zip directory still shows how many event chunks and blobs an archive holds and the blobs' content hashes.

"Export and open in Player" opens only the Player page the user or the enterprise policy configured (the extension has no built-in Player address); the archive stays in the downloads folder and neither it nor its passphrase is sent there.

The privacy scanner runs on every export and only warns: its findings are shown next to the export result, never blocking it. The public share server stores encrypted archive bytes and redacted public metadata, rejects plaintext uploads, and rejects encrypted uploads that leave private archive files (event chunks, blobs, indexes, privacy or full manifests) in plaintext. It never receives archive passphrases or decryption keys.

Public share links expire, can be revoked, and generate redacted audit events. Audit records do not include captured payloads, passphrases, API keys, raw URLs, raw selectors, or archive plaintext.

## Deletion

Deleting a local session removes local indexes, chunks, blobs, annotations, and object URLs. Revoking a share blocks future access. Expired share records and archive bytes are pruned according to the configured retention window.

## Telemetry And Logs

Operational logs and audit logs must not contain captured payloads, raw URLs, raw selectors, consent PII, passphrases, derived keys, archive plaintext, URL fragments, or selector hash keys.
