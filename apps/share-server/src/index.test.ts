import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const delayAuditAppendPreload = resolve(appRoot, "src/test-support/delay-audit-append.mjs");
const apiKey = "share-test-key";
const MIN_SHARE_TTL_MS = 1_000;
// The audit-ordering test waits on purpose: about 3 s of delayed audit writes plus one share TTL.
// That alone is close to vitest's 5 s default, so it gets room for loaded CI runners.
const AUDIT_ORDER_TEST_TIMEOUT_MS = 20_000;
const BLOB_FIXTURE_PATH =
  "blobs/sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json";
const TEXT_BLOB_FIXTURE_PATH =
  "blobs/sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.bin";

type AuditedRequestStep = {
  path: string;
  method?: string;
  status: number;
  action: string;
  outcome: string;
};

type RunningShareServer = {
  baseUrl: string;
  child: ChildProcess;
  dataDir: string;
  logs: string[];
};

let runningServers: RunningShareServer[] = [];

afterEach(async () => {
  await Promise.all(runningServers.map((server) => stopShareServer(server)));
  runningServers = [];
});

describe("share-server", () => {
  it("returns 413 when an upload exceeds the configured size limit", async () => {
    const server = await startShareServer({
      WEBBLACKBOX_SHARE_MAX_UPLOAD_BYTES: "4"
    });

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-filename": "too-large.webblackbox"
      },
      body: Buffer.from("12345")
    });

    await expect(response.json()).resolves.toEqual({
      error: "Upload payload exceeds 4 bytes."
    });
    expect(response.status).toBe(413);
  });

  it("rejects archives that inflate beyond the server analysis limit and keeps serving", async () => {
    const server = await startShareServer({
      WEBBLACKBOX_SHARE_MAX_UNCOMPRESSED_BYTES: String(64 * 1024)
    });
    const bomb = await JSZip.loadAsync(await createEncryptedEnvelopeArchive());
    bomb.file("blobs/sha256-bomb.bin", new Uint8Array(8 * 1024 * 1024));
    const bombBytes = await bomb.generateAsync({ type: "uint8array", compression: "DEFLATE" });

    expect(bombBytes.byteLength).toBeLessThan(64 * 1024);

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-filename": "bomb.webblackbox",
        "x-webblackbox-share-summary": encodeURIComponent(JSON.stringify(buildPassedShareSummary()))
      },
      body: Buffer.from(bombBytes)
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error:
        "Archive exceeds server analysis limits: Archive entry 'blobs/sha256-bomb.bin' declares " +
        "8388608 uncompressed bytes, more than the per-entry limit of 65536 bytes."
    });
    await expect(uploadEncryptedFixture(server)).resolves.toHaveProperty("shareId");
  });

  it("rejects uploads whose analysis exceeds the configured timeout", async () => {
    const server = await startShareServer({
      WEBBLACKBOX_SHARE_ANALYSIS_TIMEOUT_MS: "1"
    });

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-filename": "slow.webblackbox",
        "x-webblackbox-share-summary": encodeURIComponent(JSON.stringify(buildPassedShareSummary()))
      },
      body: Buffer.from(await createEncryptedEnvelopeArchive())
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Archive exceeds server analysis limits: Archive analysis timed out after 1 ms."
    });
  });

  it("does not advertise passphrase upload headers", async () => {
    const server = await startShareServer();

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "OPTIONS"
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "content-type,authorization,x-webblackbox-api-key,x-webblackbox-filename,x-webblackbox-share-summary,x-webblackbox-share-ttl-ms"
    );
  });

  it("returns only allowlisted public metadata", async () => {
    const server = await startShareServer();
    const secret = "customer-alpha.internal/users/reset-token-123";
    const encryptedArchive = await createEncryptedEnvelopeArchive();
    const summary = {
      schemaVersion: 1,
      source: "client",
      analyzed: true,
      encrypted: true,
      manifest: {
        origin: `https://${secret}`,
        mode: "lite",
        chunkCodec: "ndjson",
        recordedAt: "2026-02-13T00:00:00.000Z"
      },
      totals: {
        events: 1,
        errors: 0,
        requests: 0,
        actions: 0,
        durationMs: 0
      },
      topEndpoints: [
        {
          endpoint: `https://${secret}`,
          method: "GET",
          count: 1
        }
      ],
      sensitivePreview: {
        totalMatches: 1,
        samples: [{ snippet: secret }]
      },
      privacy: {
        redaction: {
          hashSensitiveValues: true,
          headerRuleCount: 2,
          cookieRuleCount: 1,
          bodyPatternCount: 3,
          blockedSelectorCount: 4
        },
        detected: {
          redactedMarkers: 1,
          hashedSensitiveValues: 0,
          sensitiveKeyMentions: 0
        },
        scanner: {
          preEncryption: true,
          status: "passed",
          findingCount: 0
        }
      }
    };

    const uploadResponse = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-filename": "customer-alpha-reset-token-123.webblackbox",
        "x-webblackbox-share-summary": encodeURIComponent(JSON.stringify(summary))
      },
      body: Buffer.from(encryptedArchive)
    });
    const uploadPayload = (await uploadResponse.json()) as { shareId: string };

    expect(uploadResponse.status).toBe(201);

    const metadataResponse = await fetch(
      `${server.baseUrl}/api/share/${uploadPayload.shareId}/meta`,
      {
        headers: {
          "x-webblackbox-api-key": apiKey
        }
      }
    );
    const metadataText = await metadataResponse.text();

    expect(metadataResponse.status).toBe(200);
    expect(metadataText).not.toContain(secret);
    expect(metadataText).not.toContain("topEndpoints");
    expect(metadataText).not.toContain("sensitivePreview");
    expect(metadataText).not.toContain("customer-alpha-reset-token-123");
  });

  it("rejects plaintext public share uploads by default", async () => {
    const server = await startShareServer();

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-filename": "plain.webblackbox"
      },
      body: Buffer.from(await createPlaintextEnvelopeArchive())
    });

    await expect(response.json()).resolves.toEqual({
      error: "Public share uploads require encrypted WebBlackbox archives."
    });
    expect(response.status).toBe(422);
  });

  it("rejects encrypted public share uploads without a client privacy preflight", async () => {
    const server = await startShareServer();

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-filename": "encrypted.webblackbox"
      },
      body: Buffer.from(await createEncryptedEnvelopeArchive())
    });

    await expect(response.json()).resolves.toEqual({
      error: "Encrypted public share uploads require a client privacy preflight summary."
    });
    expect(response.status).toBe(422);
  });

  it("accepts encrypted uploads whose preflight reported scanner findings (warn-only)", async () => {
    const server = await startShareServer();
    const summary = buildPassedShareSummary() as {
      privacy: { scanner: Record<string, unknown> };
    };
    summary.privacy.scanner = { preEncryption: true, status: "blocked", findingCount: 2 };

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-filename": "encrypted.webblackbox",
        "x-webblackbox-share-summary": encodeURIComponent(JSON.stringify(summary))
      },
      body: Buffer.from(await createEncryptedEnvelopeArchive())
    });

    expect(response.status).toBe(201);
  });

  it("rejects encrypted public share uploads with incomplete encrypted file metadata", async () => {
    const server = await startShareServer();

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-filename": "encrypted.webblackbox",
        "x-webblackbox-share-summary": encodeURIComponent(JSON.stringify(buildPassedShareSummary()))
      },
      body: Buffer.from(await createEncryptedEnvelopeArchive({ completeEncryptionMap: false }))
    });
    const payload = (await response.json()) as {
      error: string;
      missingEncryptedPaths: string[];
    };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("Encrypted WebBlackbox archive is missing encrypted file metadata.");
    expect(payload.missingEncryptedPaths).toContain("index/time.json");
  });

  it("rejects encrypted public share uploads with plaintext private files", async () => {
    const server = await startShareServer();

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-filename": "encrypted.webblackbox",
        "x-webblackbox-share-summary": encodeURIComponent(JSON.stringify(buildPassedShareSummary()))
      },
      body: Buffer.from(
        await createEncryptedEnvelopeArchive({
          privateFileMode: "plaintext"
        })
      )
    });
    const payload = (await response.json()) as {
      error: string;
      plaintextEncryptedPaths: string[];
    };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("Encrypted WebBlackbox archive contains plaintext private files.");
    expect(payload.plaintextEncryptedPaths).toContain("index/time.json");
  });

  it("rejects encrypted public share uploads with plaintext private blobs", async () => {
    const server = await startShareServer();

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-filename": "encrypted.webblackbox",
        "x-webblackbox-share-summary": encodeURIComponent(JSON.stringify(buildPassedShareSummary()))
      },
      body: Buffer.from(
        await createEncryptedEnvelopeArchive({
          blobFileMode: "plaintext"
        })
      )
    });
    const payload = (await response.json()) as {
      error: string;
      plaintextEncryptedPaths: string[];
    };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("Encrypted WebBlackbox archive contains plaintext private files.");
    expect(payload.plaintextEncryptedPaths).toContain(BLOB_FIXTURE_PATH);
  });

  it("rejects encrypted public share uploads with plaintext text blobs", async () => {
    const server = await startShareServer();

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-filename": "encrypted.webblackbox",
        "x-webblackbox-share-summary": encodeURIComponent(JSON.stringify(buildPassedShareSummary()))
      },
      body: Buffer.from(
        await createEncryptedEnvelopeArchive({
          textBlobFileMode: "plaintext"
        })
      )
    });
    const payload = (await response.json()) as {
      error: string;
      plaintextEncryptedPaths: string[];
    };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("Encrypted WebBlackbox archive contains plaintext private files.");
    expect(payload.plaintextEncryptedPaths).toContain(TEXT_BLOB_FIXTURE_PATH);
  });

  it("expires shares and blocks archive download after ttl", async () => {
    const server = await startShareServer({
      WEBBLACKBOX_SHARE_DEFAULT_TTL_MS: "1000"
    });
    const uploadPayload = await uploadEncryptedFixture(server);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const response = await fetch(`${server.baseUrl}/api/share/${uploadPayload.shareId}/archive`, {
      headers: {
        "x-webblackbox-api-key": apiKey
      }
    });

    await expect(response.json()).resolves.toEqual({
      error: "Share has expired."
    });
    expect(response.status).toBe(410);
  });

  it("revokes shares and writes redacted audit events", async () => {
    const server = await startShareServer();
    const uploadPayload = await uploadEncryptedFixture(server);

    const revokeResponse = await fetch(
      `${server.baseUrl}/api/share/${uploadPayload.shareId}/revoke`,
      {
        method: "POST",
        headers: {
          "x-webblackbox-api-key": apiKey
        }
      }
    );

    expect(revokeResponse.status).toBe(200);

    const archiveResponse = await fetch(
      `${server.baseUrl}/api/share/${uploadPayload.shareId}/archive`,
      {
        headers: {
          "x-webblackbox-api-key": apiKey
        }
      }
    );

    await expect(archiveResponse.json()).resolves.toEqual({
      error: "Share has been revoked."
    });
    expect(archiveResponse.status).toBe(410);

    const auditLog = await readFile(resolve(server.dataDir, "audit/share-access.jsonl"), "utf8");
    const auditEvents = auditLog
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { action: string; clientHash?: string });

    expect(auditEvents.some((event) => event.action === "upload")).toBe(true);
    expect(auditEvents.some((event) => event.action === "revoke")).toBe(true);
    expect(auditEvents.some((event) => event.action === "download")).toBe(true);
    expect(auditEvents.every((event) => typeof event.clientHash === "string")).toBe(true);
    expect(auditLog).not.toContain("127.0.0.1");
    expect(auditLog).not.toContain("webblackbox-share-");
  });

  it(
    "persists the audit event before sending each response",
    { timeout: AUDIT_ORDER_TEST_TIMEOUT_MS },
    async () => {
      const server = await startShareServer({
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS,
          `--import=${pathToFileURL(delayAuditAppendPreload)}`
        ]
          .filter(Boolean)
          .join(" ")
      });
      const { shareId } = await uploadEncryptedFixture(server);
      const { shareId: expiringShareId } = await uploadEncryptedFixture(server, apiKey, {
        "x-webblackbox-share-ttl-ms": String(MIN_SHARE_TTL_MS)
      });
      const expiresBy = Date.now() + MIN_SHARE_TTL_MS;
      const assertAuditedBeforeResponse = async (step: AuditedRequestStep): Promise<void> => {
        const response = await fetch(`${server.baseUrl}${step.path}`, {
          method: step.method ?? "GET",
          headers: { "x-webblackbox-api-key": apiKey }
        });
        await response.arrayBuffer();
        expect(response.status).toBe(step.status);

        const auditEvents = await readAuditEvents(server);
        expect(auditEvents.at(-1)).toMatchObject({ action: step.action, outcome: step.outcome });
      };
      const steps: AuditedRequestStep[] = [
        { path: `/api/share/${shareId}/meta`, status: 200, action: "metadata", outcome: "ok" },
        { path: `/share/${shareId}`, status: 200, action: "page", outcome: "ok" },
        { path: `/api/share/${shareId}/archive`, status: 200, action: "download", outcome: "ok" },
        {
          path: `/api/share/${shareId}/revoke`,
          method: "POST",
          status: 200,
          action: "revoke",
          outcome: "ok"
        },
        {
          path: `/api/share/${shareId}/archive`,
          status: 410,
          action: "download",
          outcome: "revoked"
        },
        {
          path: `/api/share/${"0".repeat(32)}/meta`,
          status: 404,
          action: "metadata",
          outcome: "not-found"
        }
      ];

      for (const step of steps) {
        await assertAuditedBeforeResponse(step);
      }

      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, expiresBy - Date.now() + 100))
      );
      await assertAuditedBeforeResponse({
        path: `/api/share/${expiringShareId}/archive`,
        status: 410,
        action: "download",
        outcome: "expired"
      });
    }
  );

  it("enforces scoped API keys", async () => {
    const uploadKey = "upload-scope-key";
    const readKey = "read-scope-key";
    const server = await startShareServer({
      WEBBLACKBOX_SHARE_API_KEYS: `${uploadKey}:upload;${readKey}:read`
    });
    const uploadPayload = await uploadEncryptedFixture(server, uploadKey);

    const blockedRead = await fetch(`${server.baseUrl}/api/share/${uploadPayload.shareId}/meta`, {
      headers: {
        "x-webblackbox-api-key": uploadKey
      }
    });

    expect(blockedRead.status).toBe(401);

    const allowedRead = await fetch(`${server.baseUrl}/api/share/${uploadPayload.shareId}/meta`, {
      headers: {
        "x-webblackbox-api-key": readKey
      }
    });

    expect(allowedRead.status).toBe(200);
  });

  it("serves share pages with no-referrer and strict csp headers", async () => {
    const server = await startShareServer();
    const uploadPayload = await uploadEncryptedFixture(server);

    const response = await fetch(`${server.baseUrl}/share/${uploadPayload.shareId}`, {
      headers: {
        "x-webblackbox-api-key": apiKey
      }
    });
    const html = await response.text();
    const cookie = readSetCookiePair(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(html).not.toContain("?key=");
    expect(html).not.toContain(apiKey);
    expect(cookie).toMatch(/^webblackbox_share_read=/);

    const archiveResponse = await fetch(
      `${server.baseUrl}/api/share/${uploadPayload.shareId}/archive`,
      {
        headers: {
          cookie
        }
      }
    );
    expect(archiveResponse.status).toBe(200);
  });

  it("rejects query API keys by default", async () => {
    const server = await startShareServer();
    const uploadPayload = await uploadEncryptedFixture(server);

    const response = await fetch(`${server.baseUrl}/share/${uploadPayload.shareId}?key=${apiKey}`, {
      redirect: "manual"
    });

    expect(response.status).toBe(401);
  });

  it("supports opt-in query API key bootstrap without propagating the key", async () => {
    const server = await startShareServer({
      WEBBLACKBOX_SHARE_ALLOW_QUERY_API_KEY: "true"
    });
    const uploadPayload = await uploadEncryptedFixture(server);

    const redirectResponse = await fetch(
      `${server.baseUrl}/share/${uploadPayload.shareId}?key=${apiKey}`,
      {
        redirect: "manual"
      }
    );
    const cookie = readSetCookiePair(redirectResponse);

    expect(redirectResponse.status).toBe(303);
    expect(redirectResponse.headers.get("location")).toBe(`/share/${uploadPayload.shareId}`);
    expect(redirectResponse.headers.get("location")).not.toContain(apiKey);
    expect(cookie).toMatch(/^webblackbox_share_read=/);

    const pageResponse = await fetch(`${server.baseUrl}/share/${uploadPayload.shareId}`, {
      headers: {
        cookie
      }
    });
    const html = await pageResponse.text();

    expect(pageResponse.status).toBe(200);
    expect(html).not.toContain("?key=");
    expect(html).not.toContain(apiKey);
  });

  it("never grants keyless loopback access from forwarded headers", async () => {
    const server = await startShareServer({
      WEBBLACKBOX_SHARE_API_KEY: "",
      WEBBLACKBOX_TRUST_X_FORWARDED_FOR: "true",
      WEBBLACKBOX_TRUSTED_PROXIES: "127.0.0.1"
    });

    const direct = await sendRawRequest(server, "/api/share/list");
    expect(direct.status).toBe(200);

    for (const forwarded of ["127.0.0.1", "203.0.113.7, 127.0.0.1"]) {
      const spoofed = await sendRawRequest(server, "/api/share/list", {
        "x-forwarded-for": forwarded
      });
      expect(spoofed.status).toBe(401);
    }

    const realIp = await sendRawRequest(server, "/api/share/list", { "x-real-ip": "127.0.0.1" });
    expect(realIp.status).toBe(401);
  });

  it("rejects foreign Host headers in keyless mode", async () => {
    const server = await startShareServer({
      WEBBLACKBOX_SHARE_API_KEY: ""
    });

    const rebinding = await sendRawRequest(server, "/api/share/list", {
      host: "attacker.example:8787"
    });
    expect(rebinding.status).toBe(403);
    expect(JSON.parse(rebinding.body)).toEqual({ error: "Host not allowed." });

    const preflight = await sendRawRequest(
      server,
      "/api/share/upload",
      { host: "attacker.example" },
      "OPTIONS"
    );
    expect(preflight.status).toBe(403);

    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      const allowed = await sendRawRequest(server, "/api/share/list", {
        host: `${host}:8787`
      });
      expect(allowed.status).toBe(200);
    }
  });

  it("accepts configured public hosts in keyless mode", async () => {
    const server = await startShareServer({
      WEBBLACKBOX_SHARE_API_KEY: "",
      WEBBLACKBOX_SHARE_ALLOWED_HOSTS: "share.internal.example"
    });

    const response = await sendRawRequest(server, "/api/share/list", {
      host: "share.internal.example"
    });
    expect(response.status).toBe(200);
  });

  it("checks Host headers in keyed mode only when an allowlist is configured", async () => {
    const openServer = await startShareServer();
    const keyedDefault = await sendRawRequest(openServer, "/api/share/list", {
      host: "share.example.com",
      "x-webblackbox-api-key": apiKey
    });
    expect(keyedDefault.status).toBe(200);

    const strictServer = await startShareServer({
      WEBBLACKBOX_SHARE_ALLOWED_HOSTS: "share.example.com"
    });
    const allowed = await sendRawRequest(strictServer, "/api/share/list", {
      host: "share.example.com",
      "x-webblackbox-api-key": apiKey
    });
    const blocked = await sendRawRequest(strictServer, "/api/share/list", {
      host: "other.example.com",
      "x-webblackbox-api-key": apiKey
    });
    expect(allowed.status).toBe(200);
    expect(blocked.status).toBe(403);
  });

  it("does not let rotating X-Forwarded-For entries bypass upload rate limits", async () => {
    const server = await startShareServer({
      WEBBLACKBOX_TRUST_X_FORWARDED_FOR: "true",
      WEBBLACKBOX_UPLOAD_RATE_LIMIT_MAX: "1"
    });

    const first = await sendRawRequest(
      server,
      "/api/share/upload",
      { "x-webblackbox-api-key": apiKey, "x-forwarded-for": "198.51.100.1" },
      "POST"
    );
    const second = await sendRawRequest(
      server,
      "/api/share/upload",
      { "x-webblackbox-api-key": apiKey, "x-forwarded-for": "198.51.100.2" },
      "POST"
    );

    expect(first.status).toBe(400);
    expect(second.status).toBe(429);
  });

  it("rate limits by the right-most untrusted X-Forwarded-For hop behind a trusted proxy", async () => {
    const server = await startShareServer({
      WEBBLACKBOX_TRUST_X_FORWARDED_FOR: "true",
      WEBBLACKBOX_TRUSTED_PROXIES: "127.0.0.1",
      WEBBLACKBOX_UPLOAD_RATE_LIMIT_MAX: "1"
    });
    const upload = (forwardedFor: string): Promise<RawResponse> =>
      sendRawRequest(
        server,
        "/api/share/upload",
        { "x-webblackbox-api-key": apiKey, "x-forwarded-for": forwardedFor },
        "POST"
      );

    expect((await upload("10.9.9.1, 198.51.100.1")).status).toBe(400);
    expect((await upload("10.9.9.2, 198.51.100.1")).status).toBe(429);
    expect((await upload("198.51.100.1, 198.51.100.2")).status).toBe(400);
  });
});

type RawResponse = {
  status: number;
  body: string;
};

async function sendRawRequest(
  server: RunningShareServer,
  path: string,
  headers: Record<string, string> = {},
  method = "GET"
): Promise<RawResponse> {
  const url = new URL(path, server.baseUrl);

  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolvePromise({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8")
          })
        );
        response.on("error", reject);
      }
    );

    request.on("error", reject);
    request.end();
  });
}

async function startShareServer(
  envOverrides: Record<string, string> = {}
): Promise<RunningShareServer> {
  const port = await reservePort();
  const dataDir = await mkdtemp(resolve(tmpdir(), "webblackbox-share-test-"));
  const child = spawn(process.execPath, [tsxCli, resolve(appRoot, "src/index.ts")], {
    cwd: appRoot,
    env: {
      ...process.env,
      PORT: String(port),
      WEBBLACKBOX_SHARE_API_KEY: apiKey,
      WEBBLACKBOX_SHARE_BIND_HOST: "127.0.0.1",
      WEBBLACKBOX_SHARE_DATA_DIR: dataDir,
      ...envOverrides
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const server: RunningShareServer = {
    baseUrl: `http://127.0.0.1:${port}`,
    child,
    dataDir,
    logs: []
  };

  child.stdout?.on("data", (chunk) => {
    server.logs.push(String(chunk));
  });
  child.stderr?.on("data", (chunk) => {
    server.logs.push(String(chunk));
  });
  runningServers.push(server);

  await waitForShareServer(server);
  return server;
}

async function stopShareServer(server: RunningShareServer): Promise<void> {
  if (server.child.exitCode === null && !server.child.killed) {
    server.child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      server.child.once("exit", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }

  await rm(server.dataDir, {
    recursive: true,
    force: true
  });
}

async function waitForShareServer(server: RunningShareServer): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(
        `share-server exited early with ${server.child.exitCode}: ${server.logs.join("")}`
      );
    }

    try {
      const response = await fetch(`${server.baseUrl}/api/share/list`, {
        headers: {
          "x-webblackbox-api-key": apiKey
        }
      });

      if (response.ok) {
        return;
      }
    } catch {
      // retry until the process binds the port
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`share-server did not become ready: ${server.logs.join("")}`);
}

async function reservePort(): Promise<number> {
  const server = createServer();

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to reserve a local TCP port.");
  }

  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolvePromise();
    });
  });

  return address.port;
}

async function readAuditEvents(
  server: RunningShareServer
): Promise<Array<{ action: string; outcome: string }>> {
  const auditLog = await readFile(resolve(server.dataDir, "audit/share-access.jsonl"), "utf8");
  return auditLog
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { action: string; outcome: string });
}

function readSetCookiePair(response: Response): string {
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function uploadEncryptedFixture(
  server: RunningShareServer,
  credential = apiKey,
  extraHeaders: Record<string, string> = {}
): Promise<{ shareId: string }> {
  const response = await fetch(`${server.baseUrl}/api/share/upload`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-webblackbox-api-key": credential,
      "x-webblackbox-filename": "fixture.webblackbox",
      "x-webblackbox-share-summary": encodeURIComponent(JSON.stringify(buildPassedShareSummary())),
      ...extraHeaders
    },
    body: Buffer.from(await createEncryptedEnvelopeArchive())
  });

  expect(response.status).toBe(201);
  return (await response.json()) as { shareId: string };
}

function buildPassedShareSummary(): unknown {
  return {
    schemaVersion: 1,
    source: "client",
    analyzed: true,
    encrypted: true,
    manifest: {
      mode: "lite",
      chunkCodec: "ndjson",
      recordedAt: "2026-02-13T00:00:00.000Z"
    },
    totals: {
      events: 0,
      errors: 0,
      requests: 0,
      actions: 0,
      durationMs: 0
    },
    privacy: {
      redaction: {
        hashSensitiveValues: true,
        headerRuleCount: 0,
        cookieRuleCount: 0,
        bodyPatternCount: 0,
        blockedSelectorCount: 0
      },
      detected: {
        redactedMarkers: 0,
        hashedSensitiveValues: 0,
        sensitiveKeyMentions: 0
      },
      scanner: {
        preEncryption: true,
        status: "passed",
        findingCount: 0
      }
    }
  };
}

async function createEncryptedEnvelopeArchive(
  options: {
    completeEncryptionMap?: boolean;
    privateFileMode?: "ciphertext" | "plaintext";
    blobFileMode?: "ciphertext" | "plaintext";
    textBlobFileMode?: "ciphertext" | "plaintext";
  } = {}
): Promise<Uint8Array> {
  return createEnvelopeArchive(true, options);
}

async function createPlaintextEnvelopeArchive(): Promise<Uint8Array> {
  return createEnvelopeArchive(false);
}

async function createEnvelopeArchive(
  encrypted: boolean,
  options: {
    completeEncryptionMap?: boolean;
    privateFileMode?: "ciphertext" | "plaintext";
    blobFileMode?: "ciphertext" | "plaintext";
    textBlobFileMode?: "ciphertext" | "plaintext";
  } = {}
): Promise<Uint8Array> {
  const zip = new JSZip();
  const files: Record<string, string> = {};
  const encryptedFiles =
    encrypted && options.completeEncryptionMap !== false
      ? {
          "index/time.json": { ivBase64: toBase64(randomBytes(12)) },
          "index/req.json": { ivBase64: toBase64(randomBytes(12)) },
          "index/inv.json": { ivBase64: toBase64(randomBytes(12)) },
          [BLOB_FIXTURE_PATH]: { ivBase64: toBase64(randomBytes(12)) },
          [TEXT_BLOB_FIXTURE_PATH]: { ivBase64: toBase64(randomBytes(12)) }
        }
      : {};
  const manifest = {
    protocolVersion: 1,
    createdAt: "2026-02-13T00:00:00.000Z",
    mode: "lite",
    site: {
      origin: "https://fixture.example",
      title: "Fixture"
    },
    chunkCodec: "none",
    redactionProfile: {
      redactHeaders: [],
      redactCookieNames: [],
      redactBodyPatterns: [],
      blockedSelectors: [],
      hashSensitiveValues: true
    },
    stats: {
      eventCount: 0,
      chunkCount: 0,
      blobCount: 0,
      durationMs: 0
    },
    ...(encrypted
      ? {
          encryption: {
            algorithm: "AES-GCM",
            kdf: {
              name: "PBKDF2",
              hash: "SHA-256",
              iterations: 250000,
              saltBase64: "AAAAAAAAAAAAAAAAAAAAAA=="
            },
            files: encryptedFiles
          }
        }
      : {})
  };

  addJsonFile(zip, files, "manifest.json", manifest);
  addPrivateFile(zip, files, "index/time.json", [], encrypted, options.privateFileMode);
  addPrivateFile(zip, files, "index/req.json", [], encrypted, options.privateFileMode);
  addPrivateFile(zip, files, "index/inv.json", [], encrypted, options.privateFileMode);
  addPrivateFile(
    zip,
    files,
    BLOB_FIXTURE_PATH,
    { token: "blob-secret-token" },
    encrypted,
    options.blobFileMode
  );
  addPrivateFile(
    zip,
    files,
    TEXT_BLOB_FIXTURE_PATH,
    "plain-text-secret-token",
    encrypted,
    options.textBlobFileMode
  );
  addJsonFile(zip, files, "integrity/hashes.json", {
    manifestSha256: files["manifest.json"],
    files
  });

  return zip.generateAsync({ type: "uint8array" });
}

function addJsonFile(
  zip: JSZip,
  files: Record<string, string>,
  path: string,
  value: unknown
): void {
  const content = JSON.stringify(value);
  zip.file(path, content);

  if (path !== "integrity/hashes.json") {
    files[path] = createHash("sha256").update(content).digest("hex");
  }
}

function addPrivateFile(
  zip: JSZip,
  files: Record<string, string>,
  path: string,
  value: unknown,
  encrypted: boolean,
  mode: "ciphertext" | "plaintext" = "ciphertext"
): void {
  const content = Buffer.from(JSON.stringify(value));
  const bytes =
    encrypted && mode === "ciphertext"
      ? randomBytes(Math.max(32, content.byteLength + 16))
      : content;

  zip.file(path, bytes);
  files[path] = createHash("sha256").update(bytes).digest("hex");
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
