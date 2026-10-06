import { describe, expect, it } from "vitest";

import { DEFAULT_REDACTION_PROFILE } from "./defaults.js";
import {
  isContentRedactionEnabled,
  maskBodyBytes,
  maskBodyText,
  maskQueryParams,
  maskValuePatterns,
  recordUrl,
  usesBuiltInHeuristics
} from "./redaction-rules.js";
import { redactionProfileSchema } from "./schemas.js";

const URL_WITH_SECRETS = "https://h.test/users/12345/reset?token=T1&page=2#state=S1";

describe("redaction rules", () => {
  it("masks by default and turns everything off with contentRedaction: false", () => {
    expect(isContentRedactionEnabled(undefined)).toBe(true);
    expect(isContentRedactionEnabled(DEFAULT_REDACTION_PROFILE)).toBe(true);
    expect(isContentRedactionEnabled({ contentRedaction: false })).toBe(false);
    expect(usesBuiltInHeuristics({ contentRedaction: false })).toBe(false);
    expect(usesBuiltInHeuristics({ builtInHeuristics: false })).toBe(false);
  });

  it("records URLs sanitized, as captured, or with the user's parameters masked", () => {
    expect(recordUrl(URL_WITH_SECRETS, DEFAULT_REDACTION_PROFILE)).toBe(
      "https://h.test/users/:id/reset"
    );
    expect(recordUrl(URL_WITH_SECRETS, { contentRedaction: false })).toBe(URL_WITH_SECRETS);
    expect(
      recordUrl(URL_WITH_SECRETS, {
        builtInHeuristics: false,
        redactQueryParams: ["TOKEN", "state"],
        valuePatterns: [{ pattern: "users/\\d+", targets: ["urls"] }]
      })
    ).toBe("https://h.test/[REDACTED]/reset?token=[REDACTED]&page=2#state=[REDACTED]");
    expect(maskQueryParams("/a?x%5Fid=1&y=2", ["x_id"])).toBe("/a?x%5Fid=[REDACTED]&y=2");
  });

  it("applies value patterns only to their targets and never when masking is off", () => {
    const rules = { valuePatterns: [{ pattern: "acct-\\d+", targets: ["console" as const] }] };

    expect(maskValuePatterns("id acct-42", rules, "console")).toBe("id [REDACTED]");
    expect(maskValuePatterns("id acct-42", rules, "storage")).toBe("id acct-42");
    expect(maskValuePatterns("id acct-42", { ...rules, contentRedaction: false }, "console")).toBe(
      "id acct-42"
    );
  });

  it("masks bodies by key and value rules, and keeps them as captured when off", () => {
    const body = '{"password":"P1","note":"acct-77"}';
    const rules = {
      redactBodyPatterns: ["password"],
      valuePatterns: [{ pattern: "acct-\\d+", targets: ["bodies" as const] }]
    };

    expect(maskBodyText(body, rules).value).toBe('{"password":"[REDACTED]","note":"[REDACTED]"}');
    expect(maskBodyText(body, { ...rules, contentRedaction: false })).toEqual({
      value: body,
      redacted: false
    });

    const bytes = new TextEncoder().encode(body);
    const masked = maskBodyBytes(bytes, rules, { mimeType: "application/json" });

    expect(new TextDecoder().decode(masked.bytes)).not.toContain("acct-77");
    expect(maskBodyBytes(bytes, { ...rules, contentRedaction: false }).bytes).toBe(bytes);
  });

  it("validates user value patterns in the schema", () => {
    const parse = (pattern: string) =>
      redactionProfileSchema.safeParse({
        ...DEFAULT_REDACTION_PROFILE,
        valuePatterns: [{ pattern, targets: ["bodies"] }]
      }).success;

    expect(parse("sk_live_\\w+")).toBe(true);
    expect(parse("(a)\\1")).toBe(false);
    expect(parse("(?=x)")).toBe(false);
    expect(
      redactionProfileSchema.safeParse({
        ...DEFAULT_REDACTION_PROFILE,
        valuePatterns: [{ pattern: "x", targets: [] }]
      }).success
    ).toBe(false);
  });
});
