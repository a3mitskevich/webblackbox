import { describe, expect, it } from "vitest";

import { DEFAULT_REDACTION_PROFILE, type RedactionProfile } from "@webblackbox/protocol";

import { previewRedaction } from "./redaction-sandbox.js";

const PLAIN_PROFILE: RedactionProfile = {
  ...DEFAULT_REDACTION_PROFILE,
  hashSensitiveValues: false
};

describe("previewRedaction", () => {
  it("masks body values after sensitive keys like the recorder does", () => {
    const result = previewRedaction(
      { kind: "body", text: '{"user":"ann","password":"hunter2"}' },
      PLAIN_PROFILE
    );

    expect(result.output).toBe('{"user":"ann","password":"[REDACTED]"}');
    expect(result.changed).toBe(true);
  });

  it("reports unchanged bodies", () => {
    const result = previewRedaction({ kind: "body", text: '{"user":"ann"}' }, PLAIN_PROFILE);

    expect(result).toEqual({ kind: "body", output: '{"user":"ann"}', changed: false });
  });

  it("masks credential headers and strips URL queries in headers", () => {
    const result = previewRedaction(
      {
        kind: "headers",
        text: "Authorization: Bearer abc\nReferer: https://app.test/cb?code=OAUTH1\nAccept: */*"
      },
      PLAIN_PROFILE
    );

    expect(result.output).toBe(
      "authorization: [REDACTED]\nreferer: https://app.test/cb\naccept: */*"
    );
    expect(result.output).not.toContain("OAUTH1");
    expect(result.changed).toBe(true);
  });

  it("sanitizes URLs", () => {
    const result = previewRedaction(
      { kind: "url", text: "https://app.test/users/12345/reset?token=t1#frag" },
      PLAIN_PROFILE
    );

    expect(result.output).toBe("https://app.test/users/:id/reset");
    expect(result.changed).toBe(true);
  });

  it("redacts event payloads and flags invalid JSON", () => {
    const ok = previewRedaction(
      { kind: "event", text: '{"message":"hello","apiKey":"k-1"}' },
      PLAIN_PROFILE
    );

    expect(JSON.parse(ok.output)).toEqual({ message: "hello", apiKey: "[REDACTED]" });
    expect(ok.changed).toBe(true);

    const invalid = previewRedaction({ kind: "event", text: "{oops" }, PLAIN_PROFILE);

    expect(invalid).toMatchObject({ output: "{oops", changed: false, error: "invalid-json" });
  });
});
