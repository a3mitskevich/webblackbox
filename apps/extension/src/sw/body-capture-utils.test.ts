import { describe, expect, it } from "vitest";

import { DEFAULT_REDACTION_PROFILE } from "@webblackbox/protocol";

import {
  applyBodyUrlFilters,
  isInlineRequestBodyAllowed,
  resolveFullBodyCaptureRule,
  resolveLiteBodyCaptureRule,
  transformResponseBodyForCapture
} from "./body-capture-utils.js";

const DEFAULT_PATTERNS = DEFAULT_REDACTION_PROFILE.redactBodyPatterns;

function decodeBase64ForTest(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

describe("body-capture utils", () => {
  it("gates inline request bodies with the site body-capture rule", () => {
    const config = {
      sampling: { bodyCaptureMaxBytes: 64 * 1024 },
      sitePolicies: [
        {
          originPattern: "https://bank.example.com",
          mode: "full" as const,
          enabled: true,
          allowBodyCapture: false,
          bodyMimeAllowlist: [],
          pathAllowlist: [],
          pathDenylist: []
        }
      ]
    };
    const resolveRule = (url: string, mimeType: string | undefined) =>
      resolveFullBodyCaptureRule(config, url, mimeType);

    expect(
      isInlineRequestBodyAllowed(
        {
          eventType: "network.request",
          url: "https://bank.example.com/login",
          mimeType: "application/x-www-form-urlencoded"
        },
        resolveRule
      )
    ).toBe(false);
    expect(
      isInlineRequestBodyAllowed(
        {
          eventType: "network.request",
          url: "https://app.example.com/login",
          mimeType: "application/json; charset=utf-8"
        },
        resolveRule
      )
    ).toBe(true);
    expect(isInlineRequestBodyAllowed({ eventType: "network.ws.frame" }, resolveRule)).toBe(true);
  });

  it("disables full-mode body capture when matching policy denies body capture", () => {
    const rule = resolveFullBodyCaptureRule(
      {
        sampling: {
          bodyCaptureMaxBytes: 64 * 1024
        },
        sitePolicies: [
          {
            originPattern: "https://api.example.com",
            mode: "full",
            enabled: true,
            allowBodyCapture: false,
            bodyMimeAllowlist: [],
            pathAllowlist: [],
            pathDenylist: []
          }
        ]
      },
      "https://api.example.com/v1/search",
      "application/json"
    );

    expect(rule.enabled).toBe(false);
  });

  it("disables full-mode body capture when policy mime allowlist excludes response mime", () => {
    const rule = resolveFullBodyCaptureRule(
      {
        sampling: {
          bodyCaptureMaxBytes: 64 * 1024
        },
        sitePolicies: [
          {
            originPattern: "https://api.example.com",
            mode: "full",
            enabled: true,
            allowBodyCapture: true,
            bodyMimeAllowlist: ["application/json"],
            pathAllowlist: [],
            pathDenylist: []
          }
        ]
      },
      "https://api.example.com/v1/search",
      "text/html"
    );

    expect(rule.enabled).toBe(false);
    expect(rule.mimeAllowlist).toEqual(["application/json"]);
  });

  it("keeps lite-mode default capture rule enabled for unmatched policies", () => {
    const rule = resolveLiteBodyCaptureRule(
      {
        sampling: {
          bodyCaptureMaxBytes: 64 * 1024
        },
        sitePolicies: []
      },
      "https://example.com/page",
      "image/png"
    );

    expect(rule.enabled).toBe(true);
  });

  it("treats zero bodyCaptureMaxBytes as disabled", () => {
    const rule = resolveLiteBodyCaptureRule(
      {
        sampling: {
          bodyCaptureMaxBytes: 0
        },
        sitePolicies: []
      },
      "https://example.com/page",
      "application/json"
    );

    expect(rule.enabled).toBe(false);
    expect(rule.maxBytes).toBe(0);
  });

  it("keeps response bodies as captured when content masking is off", () => {
    const body = "user=qa&password=hunter2&csrf_token=abc123";
    const transformed = transformResponseBodyForCapture({
      body,
      base64Encoded: false,
      redaction: { redactBodyPatterns: DEFAULT_PATTERNS, contentRedaction: false },
      maxBytes: 4_096,
      decodeBase64: decodeBase64ForTest
    });

    expect(transformed.redacted).toBe(false);
    expect(new TextDecoder().decode(transformed.sampledBytes)).toBe(body);
  });

  it("redacts values (not keys) and truncates utf8 response bodies for capture", () => {
    const transformed = transformResponseBodyForCapture({
      body: `user=qa&password=hunter2&csrf_token=abc123&${"x".repeat(5_000)}`,
      base64Encoded: false,
      redaction: { redactBodyPatterns: DEFAULT_PATTERNS },
      maxBytes: 4_096,
      decodeBase64: decodeBase64ForTest
    });

    const sampledText = new TextDecoder().decode(transformed.sampledBytes);

    expect(transformed.redacted).toBe(true);
    expect(transformed.truncated).toBe(true);
    expect(sampledText.startsWith("user=qa&password=[REDACTED]&csrf_token=[REDACTED]&x")).toBe(
      true
    );
    expect(sampledText).not.toContain("hunter2");
    expect(sampledText).not.toContain("abc123");
    expect(transformed.sampledBytes.byteLength).toBe(4_096);
    expect(transformed.originalBytes.byteLength).toBeGreaterThan(
      transformed.sampledBytes.byteLength
    );
  });

  it("redacts nested JSON response bodies with the default patterns", () => {
    const transformed = transformResponseBodyForCapture({
      body: JSON.stringify({ user: { id: 1, session: { accessToken: "eyJ.secret" } } }),
      base64Encoded: false,
      redaction: { redactBodyPatterns: DEFAULT_PATTERNS },
      maxBytes: 64 * 1024,
      mimeType: "application/json",
      decodeBase64: decodeBase64ForTest
    });

    expect(transformed.redacted).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(transformed.sampledBytes))).toEqual({
      user: { id: 1, session: { accessToken: "[REDACTED]" } }
    });
  });

  it("redacts base64-encoded textual response bodies", () => {
    const transformed = transformResponseBodyForCapture({
      body: Buffer.from('{"otp":"123456","ok":true}', "utf8").toString("base64"),
      base64Encoded: true,
      redaction: { redactBodyPatterns: DEFAULT_PATTERNS },
      maxBytes: 64 * 1024,
      mimeType: "application/json",
      decodeBase64: decodeBase64ForTest
    });

    const sampledText = new TextDecoder().decode(transformed.sampledBytes);

    expect(transformed.redacted).toBe(true);
    expect(transformed.truncated).toBe(false);
    expect(sampledText).toBe('{"otp":"[REDACTED]","ok":true}');
  });

  it("does not redact base64 binary response bodies", () => {
    const binary = Buffer.from("password=hunter2", "utf8");
    const transformed = transformResponseBodyForCapture({
      body: binary.toString("base64"),
      base64Encoded: true,
      redaction: { redactBodyPatterns: DEFAULT_PATTERNS },
      maxBytes: 64 * 1024,
      mimeType: "image/png",
      decodeBase64: decodeBase64ForTest
    });

    expect(transformed.redacted).toBe(false);
    expect(transformed.truncated).toBe(false);
    expect(new TextDecoder().decode(transformed.sampledBytes)).toBe("password=hunter2");
  });
});

describe("applyBodyUrlFilters", () => {
  const enabled = { enabled: true, maxBytes: 4096, mimeAllowlist: ["application/json"] };

  it("keeps the rule without filters or with empty lists", () => {
    expect(applyBodyUrlFilters(enabled, "https://a.test/x", undefined)).toBe(enabled);
    expect(
      applyBodyUrlFilters(enabled, "https://a.test/x", { includeUrls: [], excludeUrls: [] })
    ).toBe(enabled);
  });

  it("never keeps bodies of extension or browser-internal URLs, even without filters", () => {
    for (const url of [
      "chrome-extension://abcdefghijklmnop/injected.js",
      "chrome-extension:/",
      "moz-extension://uuid/content.js",
      "chrome://new-tab-page/",
      "devtools://devtools/bundled/inspector.js",
      "about:blank"
    ]) {
      expect(applyBodyUrlFilters(enabled, url, undefined).enabled, url).toBe(false);
      expect(
        applyBodyUrlFilters(enabled, url, { includeUrls: ["*"], excludeUrls: [] }).enabled,
        url
      ).toBe(false);
    }

    expect(applyBodyUrlFilters(enabled, "https://a.test/chrome-extension.js", undefined)).toBe(
      enabled
    );
  });

  it("disables bodies for excluded URLs and URLs outside the include list", () => {
    const filters = {
      includeUrls: ["https://api.stage.test/*"],
      excludeUrls: ["*/auth/*"]
    };

    expect(applyBodyUrlFilters(enabled, "https://api.stage.test/orders", filters).enabled).toBe(
      true
    );
    expect(applyBodyUrlFilters(enabled, "https://api.stage.test/auth/token", filters).enabled).toBe(
      false
    );
    expect(applyBodyUrlFilters(enabled, "https://cdn.stage.test/a.json", filters).enabled).toBe(
      false
    );
  });

  it("never re-enables a disabled rule", () => {
    const disabled = { ...enabled, enabled: false };

    expect(
      applyBodyUrlFilters(disabled, "https://a.test/", { includeUrls: ["*"], excludeUrls: [] })
    ).toBe(disabled);
  });
});
