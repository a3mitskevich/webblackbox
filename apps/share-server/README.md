# WebBlackbox Share Server

Lightweight cloud-collaboration backend for `.webblackbox` archives.

It provides:

- Upload storage (`POST /api/share/upload`)
- Share URL generation (`/share/:id`)
- Archive retrieval (`GET /api/share/:id/archive`)
- Redacted public metadata summary (`GET /api/share/:id/meta`)
- Expiry, revocation, and redacted access audit logs

## Run

```bash
cd apps/share-server
pnpm dev
```

By default the server listens on `http://127.0.0.1:8787` (`PORT` changes the port, `WEBBLACKBOX_SHARE_BIND_HOST` the host).

## Security knobs

Set these environment variables for production-like deployments:

- `WEBBLACKBOX_SHARE_API_KEY`: API key for `/api/share/*` and `/share/*` routes. If unset (keyless mode), protected routes are limited to clients whose TCP connection comes from loopback (`127.0.0.1` / `::1`) and that carry no `X-Forwarded-For`, `Forwarded`, or `X-Real-IP` header. Forwarding headers can only revoke keyless access, never grant it, so a keyless server must not sit behind a reverse proxy. Keyless mode also enforces the `Host` allowlist below. When set, clients can authenticate with either:
  - `x-webblackbox-api-key: <key>`, or
  - `authorization: Bearer <key>`
- `WEBBLACKBOX_SHARE_API_KEYS`: semicolon-separated scoped keys for rotation and least privilege. Format: `secret:scope,scope;next-secret:scope`. Supported scopes are `upload`, `read`, `list`, `revoke`, and `admin`. `admin` covers all scopes. Keep an old key and a new key configured during rotation, then remove the old key after clients are updated.
- `WEBBLACKBOX_SHARE_ALLOW_QUERY_API_KEY`: optional browser bootstrap for `GET /share/:id?key=<key>`. Keep this disabled in production unless the key is short-lived; when enabled, the server redirects to a clean URL and uses a short HttpOnly read-session cookie for page links.
- `WEBBLACKBOX_SHARE_BIND_HOST`: bind host for the HTTP server (default `127.0.0.1`).
- `WEBBLACKBOX_SHARE_ALLOWED_HOSTS`: comma-separated hostnames (or URLs; ports are ignored) accepted in the `Host` header, e.g. `share.example.com`. The allowlist always contains `localhost`, `127.0.0.1`, `[::1]`, and the bind host when it is a specific address (not `0.0.0.0` / `::`). Requests with any other `Host` get `403` before routing. This blocks DNS-rebinding attacks against keyless servers. It is always enforced in keyless mode; with API keys it is enforced only when this variable is set. Set it to your public hostname for production deployments.
- `WEBBLACKBOX_SHARE_ALLOWED_ORIGIN`: CORS allow origin. Defaults to `same-origin`. Use `*` only for trusted environments.
- `WEBBLACKBOX_SHARE_MAX_UPLOAD_BYTES`: max accepted upload body size in bytes (default `262144000`).
- `WEBBLACKBOX_SHARE_MAX_UNCOMPRESSED_BYTES`: max total uncompressed size of an uploaded archive, and of its decoded event chunks, in bytes (default `1073741824`, 1 GiB). A single entry is also capped at 256 MiB or this value, whichever is lower. Larger archives are rejected with `413`.
- `WEBBLACKBOX_SHARE_ANALYSIS_TIMEOUT_MS`: wall-clock budget for analyzing an upload (default `30000`). Each upload is analyzed in a worker thread that is terminated on timeout, and the upload is rejected with `413`.
- `WEBBLACKBOX_SHARE_ANALYSIS_MAX_HEAP_MB`: V8 heap limit of the analysis worker in MiB (default `1024`). Exceeding it rejects the upload instead of crashing the server.
- `WEBBLACKBOX_SHARE_ANALYSIS_CONCURRENCY`: maximum number of analysis workers running at once (default `2`). Further uploads wait for a free slot; the analysis timeout starts when their worker starts. Peak analysis memory is roughly this value times the heap and uncompressed limits above.
- Uploads are always encrypted: plaintext archives are rejected (the former `WEBBLACKBOX_SHARE_ALLOW_PLAINTEXT_UPLOADS` switch is gone). An upload also needs the client privacy preflight summary (see the upload API below); its scanner findings are reported, not blocking.
- `WEBBLACKBOX_SHARE_DEFAULT_TTL_MS`: default share lifetime in ms (default `604800000`, seven days).
- `WEBBLACKBOX_SHARE_MAX_TTL_MS`: maximum accepted share lifetime in ms (default `2592000000`, 30 days).
- `WEBBLACKBOX_SHARE_RETAIN_EXPIRED_MS`: how long expired share records/files are retained before pruning (default `2592000000`, 30 days).
- `WEBBLACKBOX_UPLOAD_RATE_LIMIT_MAX`: max uploads per client in each window (default `10`).
- `WEBBLACKBOX_UPLOAD_RATE_LIMIT_WINDOW_MS`: upload rate limit window in ms (default `60000`).
- `WEBBLACKBOX_TRUST_X_FORWARDED_FOR`: set `true` only behind a trusted proxy. It takes effect only together with `WEBBLACKBOX_TRUSTED_PROXIES`; otherwise upload rate limiting and audit client hashes use the socket IP (the server logs a warning at startup).
- `WEBBLACKBOX_TRUSTED_PROXIES`: comma-separated IPs or CIDR ranges of your reverse proxies, e.g. `10.0.0.5,172.16.0.0/12,fd00::/8`. Default: none. `X-Forwarded-For` is read only when the TCP peer is in this list. The client address is the right-most entry that is not a trusted proxy, so entries a client prepends cannot change it. Invalid entries are ignored with a startup warning.

Behind a reverse proxy, configure both forwarding variables and the public host:

```bash
WEBBLACKBOX_TRUST_X_FORWARDED_FOR=true
WEBBLACKBOX_TRUSTED_PROXIES="10.0.0.5"
WEBBLACKBOX_SHARE_ALLOWED_HOSTS="share.example.com"
```

For production, prefer scoped keys over a single admin key:

```bash
WEBBLACKBOX_SHARE_API_KEYS="upload-v2:upload;reader-v2:read;ops-v2:list,revoke"
```

Rotation pattern:

1. Add the new key beside the old key with the same or narrower scopes.
2. Deploy and update clients.
3. Confirm audit logs show the new key path in use without storing raw key material.
4. Remove the old key and redeploy.

## API

### Upload archive

`POST /api/share/upload`

Headers:

- `content-type: application/octet-stream`
- `x-webblackbox-filename: <optional>`: only its `.zip` / `.webblackbox` extension is kept; the record's download name is `webblackbox-share-<first 12 characters of the id>.<ext>` (`.webblackbox` unless the name ends in `.zip`)
- `x-webblackbox-share-summary: <required URL-encoded JSON public summary computed client-side>`: without a summary whose privacy scanner ran before encryption, the upload is rejected with `422`
- `x-webblackbox-share-ttl-ms: <optional requested TTL, clamped between 1 second and WEBBLACKBOX_SHARE_MAX_TTL_MS>`
- `x-webblackbox-api-key: <key>` (or `authorization: Bearer <key>`): required when API keys are configured

Body:

- Raw encrypted `.webblackbox` bytes. Plaintext uploads are never accepted.
- Encrypted uploads must include encryption metadata for every private archive path: `events/*`, `blobs/*`, `index/time.json`, `index/req.json`, `index/inv.json`, `meta/manifest.json` (format-2 archives), and `privacy/manifest.json` when present. Private files whose content still looks like plaintext are rejected too. Legacy encrypted archives that left private indexes in plaintext must be re-exported with the current exporter before public share upload.

Each upload is analyzed in a worker thread within the limits above, and rate limited per client address. The returned `shareUrl` is built from the request's `Host` header (checked against the allowlist when it is enforced) and `X-Forwarded-Proto`.

Response:

```json
{
  "shareId": "abc123...",
  "shareUrl": "http://localhost:8787/share/abc123...",
  "expiresAt": 1770902400000,
  "fileName": "webblackbox-share-abc123.webblackbox",
  "sizeBytes": 123456,
  "summary": {
    "schemaVersion": 1,
    "source": "client",
    "analyzed": true,
    "encrypted": true
  }
}
```

### Metadata and archive

- `GET /api/share/list`
- `GET /api/share/:id/meta`
- `GET /api/share/:id/archive`
- `GET /share/:id`
- `POST /api/share/:id/revoke`

With API keys configured, each route needs a key with its scope: `upload`, `list`, `read` (`meta`, `archive` and the `/share/:id` page) or `revoke`. The `/share/:id` page shows the public metadata with links to download the archive and to the metadata JSON; it does not open the Player. Expired or revoked shares return `410`.

The Player loads a shared archive from a `?share=<id or URL>` link. That link is untrusted on the Player side: it never changes the saved server or API key, and an archive from an origin other than the Player page, the default or the saved server opens only after the user confirms it.

## Data storage

The server stores data under:

- `WEBBLACKBOX_SHARE_DATA_DIR` env var (if provided), otherwise
- `.webblackbox-share-data/` in the current working directory

Each share writes:

- `archives/<id>.webblackbox` (the encrypted archive as uploaded)
- `records/<id>.json`: id, created / expiry / revocation times, the server-generated file name, size, SHA-256 checksum, share URL, and the redacted public summary
- `audit/share-access.jsonl`: one event per `upload`, `list`, `metadata`, `download`, `page` and `revoke` request that reaches its handler (unauthorized, rate-limited, empty or oversized requests are not logged), with schema version, timestamp, action, outcome (`ok`, `not-found`, `expired`, `revoked`, `blocked`, `error`), share id, a SHA-256 hash of the client address, and numeric details (size and TTL of an upload)

The audit event is written before the response is sent. Audit logs must not contain archive plaintext, passphrases, API keys, raw URLs, filenames supplied by the client, or request payloads. Expired shares are pruned (record and archive) after `WEBBLACKBOX_SHARE_RETAIN_EXPIRED_MS`, at startup and on `list`.
