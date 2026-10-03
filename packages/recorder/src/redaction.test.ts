import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_RECORDER_CONFIG,
  DEFAULT_REDACTION_PROFILE,
  type RedactionProfile
} from "@webblackbox/protocol";

import { WebBlackboxRecorder } from "./recorder.js";
import { createRedactionHashKey, redactPayload } from "./redaction.js";

const HEX_64 = /^[a-f0-9]{64}$/;
const PLAIN_PROFILE: RedactionProfile = {
  ...DEFAULT_REDACTION_PROFILE,
  hashSensitiveValues: false
};

function redactHeaders(
  headers: Record<string, unknown>,
  profile: RedactionProfile = DEFAULT_REDACTION_PROFILE
): Record<string, unknown> {
  const redacted = redactPayload({ headers }, profile) as { headers: Record<string, unknown> };
  return redacted.headers;
}

describe("redactPayload headers", () => {
  it("strips query and fragment from URL-valued headers", () => {
    const headers = redactHeaders({
      Location: "https://app.example.test/oauth/callback?code=OAUTH123&state=xyz#access_token=t",
      Referer: "https://app.example.test/login?code=OAUTH123",
      ":path": "/oauth/callback?code=OAUTH123",
      "Content-Location": "/report?token=abc",
      src: "https://cdn.example.test/a.js?sig=OAUTH123",
      "X-Original-URL": "/admin?code=OAUTH123"
    });

    expect(headers).toEqual({
      Location: "https://app.example.test/oauth/callback",
      Referer: "https://app.example.test/login",
      ":path": "/oauth/callback",
      "Content-Location": "/report",
      src: "https://cdn.example.test/a.js",
      "X-Original-URL": "/admin"
    });
    expect(JSON.stringify(headers)).not.toContain("OAUTH123");
  });

  it("masks unlisted headers whose name looks like a credential", () => {
    const headers = redactHeaders(
      {
        "X-Access-Token": "at-123",
        "X-Session-Id": "sess-1",
        "X-Client-Secret": "cs-1",
        "X-Amz-Signature": "sig-1",
        "X-Otp-Code": "123456",
        "X-Refresh": ["r-1"],
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Basic realm="app"'
      },
      PLAIN_PROFILE
    );

    expect(headers).toEqual({
      "X-Access-Token": "[REDACTED]",
      "X-Session-Id": "[REDACTED]",
      "X-Client-Secret": "[REDACTED]",
      "X-Amz-Signature": "[REDACTED]",
      "X-Otp-Code": "[REDACTED]",
      "X-Refresh": ["r-1"],
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Basic realm="app"'
    });
  });

  it("hashes credential-like and listed header values when hashing is enabled", () => {
    const headers = redactHeaders({
      "X-Access-Token": "at-123",
      Authorization: "Bearer abc",
      "X-Api-Key": ["k-1", "k-2"]
    });

    expect(headers["X-Access-Token"]).toMatch(HEX_64);
    expect(headers.Authorization).toMatch(HEX_64);
    expect(headers["X-Api-Key"]).toBe("[REDACTED]");
  });

  it("still redacts cookie headers by cookie name when they are not listed", () => {
    const headers = redactHeaders(
      { Cookie: "session=s-1; theme=dark", "Set-Cookie": "jwt=j-1; Path=/; HttpOnly" },
      { ...PLAIN_PROFILE, redactHeaders: [] }
    );

    expect(headers).toEqual({
      Cookie: "session=[REDACTED]; theme=dark",
      "Set-Cookie": "jwt=[REDACTED]; Path=/; HttpOnly"
    });
  });
});

describe("redactPayload URL fields", () => {
  it("sanitizes referrer and src payload fields", () => {
    const redacted = redactPayload(
      {
        referrer: "https://app.example.test/reset?code=OAUTH123",
        src: "https://cdn.example.test/img.png?token=abc",
        referrerPolicy: "strict-origin"
      },
      DEFAULT_REDACTION_PROFILE
    );

    expect(redacted).toEqual({
      referrer: "https://app.example.test/reset",
      src: "https://cdn.example.test/img.png",
      referrerPolicy: "strict-origin"
    });
  });
});

describe("redactPayload keyed hashing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses HMAC-SHA-256 (RFC 4231 test case 2)", () => {
    const redacted = redactPayload(
      { token: "what do ya want for nothing?" },
      DEFAULT_REDACTION_PROFILE,
      { hashKey: new TextEncoder().encode("Jefe") }
    ) as { token: string };

    expect(redacted.token).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  it("hashes keys longer than the block size first (RFC 4231 test case 6)", () => {
    const redacted = redactPayload(
      { token: "Test Using Larger Than Block-Size Key - Hash Key First" },
      DEFAULT_REDACTION_PROFILE,
      { hashKey: new Uint8Array(131).fill(0xaa) }
    ) as { token: string };

    expect(redacted.token).toBe("60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
  });

  it("does not emit a plain SHA-256 of the secret", () => {
    const otp = "123456";
    const redacted = redactPayload({ otp }, DEFAULT_REDACTION_PROFILE) as { otp: string };
    const plainSha256 = createHash("sha256").update(otp).digest("hex");

    expect(redacted.otp).toMatch(HEX_64);
    expect(redacted.otp).not.toBe(plainSha256);
  });

  it("is stable for one key and differs between keys", () => {
    const keyA = createRedactionHashKey();
    const keyB = createRedactionHashKey();
    const hashWith = (hashKey: Uint8Array): unknown =>
      (
        redactPayload({ password: "hunter2" }, DEFAULT_REDACTION_PROFILE, { hashKey }) as {
          password: unknown;
        }
      ).password;

    expect(keyA).toHaveLength(32);
    expect(hashWith(keyA)).toBe(hashWith(keyA));
    expect(hashWith(keyA)).not.toBe(hashWith(keyB));
    expect(hashWith(keyA)).toMatch(HEX_64);
  });

  it("falls back to a realm-wide random key when none is passed", () => {
    const first = redactPayload({ secret: "s" }, DEFAULT_REDACTION_PROFILE);
    const second = redactPayload({ secret: "s" }, DEFAULT_REDACTION_PROFILE);

    expect(first).toEqual(second);
  });

  it("requires crypto.getRandomValues for key generation", () => {
    vi.stubGlobal("crypto", undefined);

    expect(() => createRedactionHashKey()).toThrow(/crypto\.getRandomValues/);
  });

  it("keys hashes per recorder session without exposing the key", () => {
    const ingestSelector = (recorder: WebBlackboxRecorder): unknown =>
      recorder.ingest({
        source: "content",
        rawType: "click",
        sid: "S-hmac",
        tabId: 1,
        t: 1,
        mono: 1,
        payload: { selector: "input#password" }
      }).event?.data;

    const config = { ...DEFAULT_RECORDER_CONFIG, mode: "full" as const };
    const recorderA = new WebBlackboxRecorder(config);
    const recorderB = new WebBlackboxRecorder(config);
    const first = ingestSelector(recorderA) as { selector: string };
    const repeat = ingestSelector(recorderA) as { selector: string };
    const other = ingestSelector(recorderB) as { selector: string };

    expect(first.selector).toMatch(/^selector:[a-f0-9]{12}$/);
    expect(repeat.selector).toBe(first.selector);
    expect(other.selector).not.toBe(first.selector);
    expect(JSON.stringify(config)).not.toContain("hashKey");
  });
});
