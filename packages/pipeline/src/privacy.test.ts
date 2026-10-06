import { DEFAULT_CAPTURE_POLICY, type WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import {
  assemblePrivacyManifest,
  buildPrivacyManifest,
  scanPrivacyBlob,
  scanPrivacyEvents
} from "./privacy.js";
import type { StoredBlob } from "./storage.js";

function createEvent(
  id: string,
  data: unknown = {},
  tab = 2_104_634_568,
  type: WebBlackboxEvent["type"] = "network.request"
): WebBlackboxEvent {
  return {
    v: 1,
    sid: "S-privacy-scan",
    tab,
    t: 1_778_655_646_749,
    mono: 1_778_655_646_749.5,
    type,
    id,
    privacy: {
      category: "network",
      sensitivity: "medium",
      redacted: false
    },
    data
  };
}

describe("privacy scanner", () => {
  it("does not classify browser numeric event metadata as phone numbers", async () => {
    const manifest = await buildPrivacyManifest({
      events: [createEvent("E-tab-id")],
      blobs: [],
      encrypted: true
    });

    expect(manifest.scanner.status).toBe("passed");
    expect(manifest.scanner.findings).toEqual([]);
  });

  it("still scans string payload leaves for phone numbers", async () => {
    const manifest = await buildPrivacyManifest({
      events: [createEvent("E-phone", { message: "Call support at 415-555-0101" })],
      blobs: [],
      encrypted: true
    });

    expect(manifest.scanner.status).toBe("blocked");
    expect(manifest.scanner.findings).toMatchObject([
      {
        kind: "phone",
        path: "event:E-phone",
        matchCount: 1
      }
    ]);
  });

  it("does not scan recorder config policy metadata as captured content", async () => {
    const manifest = await buildPrivacyManifest({
      events: [
        createEvent(
          "E-config",
          {
            redaction: {
              redactHeaders: ["x-api-key"],
              redactBodyPatterns: ["private_key"]
            }
          },
          2_104_634_568,
          "meta.config"
        )
      ],
      blobs: [],
      encrypted: true
    });

    expect(manifest.scanner.status).toBe("passed");
  });
});

function createBlob(hash: string, mime: string, text: string): StoredBlob {
  const bytes = new TextEncoder().encode(text);

  return {
    hash,
    mime,
    size: bytes.byteLength,
    bytes,
    createdAt: 1_778_655_646_749,
    refCount: 1
  };
}

async function scanText(text: string) {
  const manifest = await buildPrivacyManifest({
    events: [createEvent("E-scan", { text })],
    blobs: [],
    encrypted: true
  });

  return manifest.scanner;
}

describe("privacy scanner patterns", () => {
  it.each([
    ["private-key", "-----BEGIN RSA PRIVATE KEY-----"],
    [
      "jwt",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
    ],
    ["bearer-token", "Authorization: Bearer abcdefghijklmnop1234"],
    ["api-key", "api_key=ABCDEFGHIJKLMNOP1234"],
    ["oauth-code", "code=ABCDEFGHIJKLMNOPQRST"],
    ["session-cookie", "sessionid=abcdef1234567890"],
    ["email", "contact qa@example.com"],
    ["credit-card", "card: 5555 5555 5555 4444"],
    ["ssn", "ssn 123-45-6789"],
    ["long-secret", `secret=${"a1".repeat(20)}`]
  ] as const)("flags %s values", async (kind, text) => {
    const scanner = await scanText(text);

    expect(scanner.status).toBe("blocked");
    expect(scanner.preEncryption).toBe(true);
    expect(scanner.findings.map((finding) => finding.kind)).toContain(kind);

    const finding = scanner.findings.find((item) => item.kind === kind);
    expect(finding).toMatchObject({ severity: "high", path: "event:E-scan" });
    expect(finding?.sampleSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("ignores card-like numbers that fail the Luhn checksum", async () => {
    const scanner = await scanText("card: 4111 1111 1111 1112");

    expect(scanner.findings.some((finding) => finding.kind === "credit-card")).toBe(false);
  });

  it("caps match counts per finding at 25", async () => {
    const emails = Array.from({ length: 40 }, (_, index) => `user${index}@example.com`).join(" ");
    const scanner = await scanText(emails);

    expect(scanner.findings).toEqual([expect.objectContaining({ kind: "email", matchCount: 25 })]);
  });

  it("collects string leaves from nested data, refs, cdp metadata and frames", async () => {
    const event: WebBlackboxEvent = {
      ...createEvent("E-nested", {
        list: [{ deep: ["no secrets here", 42, null, "sessionid=abcdef1234567890"] }]
      }),
      frame: "frame owner@example.com",
      ref: { req: "R-1", act: "ssn 123-45-6789" },
      cdp: "session Bearer abcdefghijklmnop1234"
    };

    const manifest = await buildPrivacyManifest({ events: [event], blobs: [], encrypted: true });

    expect(manifest.scanner.findings.map((finding) => finding.kind).sort()).toEqual([
      "bearer-token",
      "email",
      "session-cookie",
      "ssn"
    ]);
  });
});

describe("privacy scanner blob scanning", () => {
  it.each([
    "text/plain",
    "application/json; charset=utf-8",
    "application/xml",
    "application/javascript",
    "application/x-www-form-urlencoded",
    "TEXT/HTML"
  ])("scans %s blobs as text", async (mime) => {
    const manifest = await buildPrivacyManifest({
      events: [],
      blobs: [createBlob("hash-text", mime, "owner@example.com")],
      encrypted: true
    });

    expect(manifest.scanner.findings).toEqual([
      expect.objectContaining({ kind: "email", path: "blob:hash-text", matchCount: 1 })
    ]);
  });

  it("skips binary blobs", async () => {
    const manifest = await buildPrivacyManifest({
      events: [],
      blobs: [createBlob("hash-image", "image/png", "owner@example.com")],
      encrypted: true
    });

    expect(manifest.scanner.status).toBe("passed");
    expect(manifest.totals.blobs).toBe(1);
  });
});

describe("privacy manifest", () => {
  it("summarizes categories, totals, encryption and policy metadata", async () => {
    const withPrivacy = (
      id: string,
      privacy: NonNullable<WebBlackboxEvent["privacy"]>,
      type: WebBlackboxEvent["type"] = "network.request"
    ): WebBlackboxEvent => ({ ...createEvent(id, {}, 1, type), privacy });
    const transfer = {
      destination: "local-download",
      archiveKeyEnvelope: DEFAULT_CAPTURE_POLICY.encryption.archiveKeyEnvelope,
      encrypted: false,
      includeScreenshots: true,
      includeScreenRecordings: false,
      maxArchiveBytes: null,
      recentWindowMs: null,
      shareEligible: false,
      computedAt: "2026-01-01T00:00:00.000Z"
    } as const;
    const withoutPrivacy: WebBlackboxEvent = { ...createEvent("E-none"), privacy: undefined };

    const manifest = await buildPrivacyManifest({
      events: [
        withPrivacy("E-net", { category: "network", sensitivity: "medium", redacted: false }),
        withPrivacy("E-in-1", { category: "inputs", sensitivity: "high", redacted: true }),
        withPrivacy("E-in-2", { category: "inputs", sensitivity: "low", redacted: false }),
        withPrivacy(
          "E-violation",
          { category: "system", sensitivity: "high", redacted: true },
          "privacy.violation"
        ),
        withoutPrivacy
      ],
      blobs: [],
      capturePolicy: DEFAULT_CAPTURE_POLICY,
      encrypted: false,
      transfer,
      generatedAt: new Date("2026-02-03T04:05:06.000Z")
    });

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.generatedAt).toBe("2026-02-03T04:05:06.000Z");
    expect(manifest.effectivePolicy).toBe(DEFAULT_CAPTURE_POLICY);
    expect(manifest.consent).toBe(DEFAULT_CAPTURE_POLICY.consent);
    expect(manifest.transfer).toBe(transfer);
    expect(manifest.encryption).toEqual({ archive: "plaintext", algorithm: undefined });
    expect(manifest.totals).toEqual({ events: 5, blobs: 0, privacyViolations: 1 });
    expect(manifest.categories).toEqual([
      { category: "inputs", events: 2, low: 1, medium: 0, high: 1, redacted: 1, unredacted: 1 },
      { category: "network", events: 1, low: 0, medium: 1, high: 0, redacted: 0, unredacted: 1 },
      { category: "system", events: 1, low: 0, medium: 0, high: 1, redacted: 1, unredacted: 0 }
    ]);
  });

  it("reports AES-GCM for encrypted archives", async () => {
    const manifest = await buildPrivacyManifest({ events: [], blobs: [], encrypted: true });

    expect(manifest.encryption).toEqual({ archive: "encrypted", algorithm: "AES-GCM" });
    expect(manifest.categories).toEqual([]);
  });

  it("assembles the same manifest from per-chunk and per-blob scans", async () => {
    const generatedAt = new Date(0);
    const events = [
      createEvent("E-a", { message: "mail me at someone@example.test" }),
      createEvent("E-b", { message: "nothing here" }, 1, "privacy.violation"),
      createEvent("E-c", { message: "Call support at 415-555-0101" })
    ];
    const blob: StoredBlob = {
      hash: "b".repeat(64),
      mime: "application/json",
      size: 40,
      bytes: new TextEncoder().encode('{"token":"Bearer abcdefghijklmnopqrstuvwx"}'),
      createdAt: 0,
      refCount: 1
    };
    const whole = await buildPrivacyManifest({
      events,
      blobs: [blob],
      encrypted: true,
      generatedAt
    });
    const pieces = assemblePrivacyManifest({
      eventScans: [
        await scanPrivacyEvents(events.slice(0, 2)),
        await scanPrivacyEvents(events.slice(2))
      ],
      blobFindings: [await scanPrivacyBlob(blob)],
      blobCount: 1,
      encrypted: true,
      generatedAt
    });

    expect({ ...pieces, scanner: { ...pieces.scanner, scannedAt: "" } }).toEqual({
      ...whole,
      scanner: { ...whole.scanner, scannedAt: "" }
    });
    expect(pieces.totals).toEqual({ events: 3, blobs: 1, privacyViolations: 1 });
    expect(pieces.scanner.findings.map((finding) => finding.path)).toEqual([
      "event:E-a",
      "event:E-c",
      `blob:${blob.hash}`
    ]);
  });
});
