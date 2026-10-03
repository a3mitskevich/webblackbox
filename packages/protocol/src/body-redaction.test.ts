import { describe, expect, it } from "vitest";

import {
  BODY_REDACTION_TOKEN,
  isTextualMimeType,
  redactBodyBytes,
  redactBodyText
} from "./body-redaction.js";
import { DEFAULT_REDACTION_PROFILE } from "./defaults.js";

const PATTERNS = DEFAULT_REDACTION_PROFILE.redactBodyPatterns;

function redact(value: string): ReturnType<typeof redactBodyText> {
  return redactBodyText(value, PATTERNS);
}

describe("redactBodyText", () => {
  describe("JSON", () => {
    it("masks the value of a sensitive key and keeps the key", () => {
      const result = redact('{"username":"alice","password":"hunter2"}');

      expect(result.redacted).toBe(true);
      expect(JSON.parse(result.value)).toEqual({
        username: "alice",
        password: BODY_REDACTION_TOKEN
      });
      expect(result.value).not.toContain("hunter2");
    });

    it("masks nested objects and arrays", () => {
      const result = redact(
        JSON.stringify({
          user: { profile: { name: "bob" }, auth: { refresh_token: "r-123", accessToken: "a-1" } },
          items: [
            { id: 1, apiKey: "k-1" },
            { id: 2, client_secret: 42 }
          ],
          otpCode: true
        })
      );

      expect(JSON.parse(result.value)).toEqual({
        user: {
          profile: { name: "bob" },
          auth: { refresh_token: BODY_REDACTION_TOKEN, accessToken: BODY_REDACTION_TOKEN }
        },
        items: [
          { id: 1, apiKey: BODY_REDACTION_TOKEN },
          { id: 2, client_secret: BODY_REDACTION_TOKEN }
        ],
        otpCode: BODY_REDACTION_TOKEN
      });
    });

    it("masks a whole object or array stored under a sensitive key", () => {
      const result = redact('{"credentials":{"user":"u","pass":"p"},"tokens":["t1","t2"],"ok":1}');

      expect(JSON.parse(result.value)).toEqual({
        credentials: BODY_REDACTION_TOKEN,
        tokens: BODY_REDACTION_TOKEN,
        ok: 1
      });
    });

    it("redacts key/value text embedded in JSON string values", () => {
      const result = redact(
        JSON.stringify({
          body: "user=bob&password=hunter2",
          query: 'mutation { login(password: "hunter2") }'
        })
      );

      expect(result.redacted).toBe(true);
      expect(result.value).not.toContain("hunter2");
      expect(JSON.parse(result.value)).toEqual({
        body: `user=bob&password=${BODY_REDACTION_TOKEN}`,
        query: `mutation { login(password: "${BODY_REDACTION_TOKEN}") }`
      });
    });

    it("keeps null and empty values and returns the original text when nothing matched", () => {
      const source = '{ "password": null, "token": "", "name": "x" }';
      const result = redact(source);

      expect(result).toEqual({ value: source, redacted: false });
    });

    it("preserves pretty-printing for multi-line JSON", () => {
      const result = redact('{\n  "password": "hunter2",\n  "a": 1\n}');

      expect(result.value).toBe(`{\n  "password": "${BODY_REDACTION_TOKEN}",\n  "a": 1\n}`);
    });

    it("falls back to text scanning for truncated JSON", () => {
      const result = redact('{"user":"bob","password":"hunter2","token": 12345, "next":"tru');

      expect(result.redacted).toBe(true);
      expect(result.value).toBe(
        `{"user":"bob","password":"${BODY_REDACTION_TOKEN}","token": ${BODY_REDACTION_TOKEN}, "next":"tru`
      );
    });

    it("masks an unterminated quoted value up to the end of the text", () => {
      const result = redact('{"user":"bob","password":"hunt');

      expect(result.value).toBe(`{"user":"bob","password":"${BODY_REDACTION_TOKEN}`);
    });

    it("handles escaped (double-encoded) JSON strings", () => {
      const result = redact('payload={\\"password\\":\\"hunter2\\",\\"a\\":1}');

      expect(result.value).toBe(`payload={\\"password\\":\\"${BODY_REDACTION_TOKEN}\\",\\"a\\":1}`);
    });
  });

  describe("form-urlencoded and query strings", () => {
    it("masks form values for sensitive keys", () => {
      const result = redact("username=alice&password=hunter2&remember=1");

      expect(result).toEqual({
        value: `username=alice&password=${BODY_REDACTION_TOKEN}&remember=1`,
        redacted: true
      });
    });

    it("masks percent-encoded values and bracketed keys", () => {
      const result = redact("user%5Bpassword%5D=p%40ss+word&user[api_key]=k-1&x=y");

      expect(result.value).toBe(
        `user%5Bpassword%5D=${BODY_REDACTION_TOKEN}&user[api_key]=${BODY_REDACTION_TOKEN}&x=y`
      );
    });

    it("masks query parameters inside URLs and keeps fragments", () => {
      const result = redact("https://example.com/cb?state=1&access_token=abc.def#done");

      expect(result.value).toBe(
        `https://example.com/cb?state=1&access_token=${BODY_REDACTION_TOKEN}#done`
      );
    });

    it("leaves empty values alone", () => {
      expect(redact("password=&user=bob")).toEqual({
        value: "password=&user=bob",
        redacted: false
      });
    });
  });

  describe("plain text and XML", () => {
    it("masks the value after a `key: value` separator up to the end of the line", () => {
      const result = redact("user: bob\nPassword: correct horse battery  \nnext: 1");

      expect(result.value).toBe(`user: bob\nPassword: ${BODY_REDACTION_TOKEN}  \nnext: 1`);
    });

    it("masks quoted XML attributes and element text", () => {
      const result = redact(
        '<login user="bob" password="hunter2"><apiKey type="x">k-1</apiKey><otp/></login>'
      );

      expect(result.value).toBe(
        `<login user="bob" password="${BODY_REDACTION_TOKEN}"><apiKey type="x">${BODY_REDACTION_TOKEN}</apiKey><otp/></login>`
      );
    });

    it("does not touch prose without a key/value separator", () => {
      const source = "Forgot your password? Request a new token from https://secret.example.com/x";

      expect(redact(source)).toEqual({ value: source, redacted: false });
    });

    it("does not treat the key itself as the secret", () => {
      const result = redact('{"password":"hunter2"}');

      expect(result.value).toContain('"password"');
      expect(result.value).not.toContain(`"${BODY_REDACTION_TOKEN}":`);
    });

    it("ignores matches inside very long identifier runs", () => {
      const source = `${"a".repeat(200)}password${"b".repeat(200)}=value`;

      expect(redact(source).redacted).toBe(false);
    });

    it("uses a custom token and treats `$` literally", () => {
      const result = redactBodyText("secret=abc", ["SECRET"], "$&-masked");

      expect(result.value).toBe("secret=$&-masked");
    });

    it("stays fast on pathological input", () => {
      const source = "token: ".repeat(150_000);
      const startedAt = performance.now();
      const result = redact(source);

      expect(result.redacted).toBe(true);
      expect(performance.now() - startedAt).toBeLessThan(2_000);
    });
  });

  it("returns the input untouched without patterns or text", () => {
    expect(redactBodyText("password=1", [" ", ""])).toEqual({
      value: "password=1",
      redacted: false
    });
    expect(redact("")).toEqual({ value: "", redacted: false });
  });
});

describe("redactBodyBytes", () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  it("redacts textual bodies", () => {
    const result = redactBodyBytes(encoder.encode("login=bob&password=hunter2"), PATTERNS, {
      mimeType: "application/x-www-form-urlencoded; charset=UTF-8"
    });

    expect(result.redacted).toBe(true);
    expect(decoder.decode(result.bytes)).toBe(`login=bob&password=${BODY_REDACTION_TOKEN}`);
  });

  it("keeps the original bytes when nothing matched", () => {
    const bytes = encoder.encode('{"ok":true}');
    const result = redactBodyBytes(bytes, PATTERNS, { mimeType: "application/json" });

    expect(result.redacted).toBe(false);
    expect(result.bytes).toBe(bytes);
  });

  it("skips binary MIME types", () => {
    const bytes = encoder.encode("password=hunter2");
    const result = redactBodyBytes(bytes, PATTERNS, { mimeType: "image/png" });

    expect(result.redacted).toBe(false);
    expect(result.bytes).toBe(bytes);
  });

  it("redacts bodies without a MIME type only when they are valid UTF-8", () => {
    const text = redactBodyBytes(encoder.encode("token=abc"), PATTERNS, {
      redactionToken: "***"
    });
    const binary = new Uint8Array([0xff, 0xfe, ...encoder.encode("token=abc")]);
    const binaryResult = redactBodyBytes(binary, PATTERNS);

    expect(decoder.decode(text.bytes)).toBe("token=***");
    expect(binaryResult.redacted).toBe(false);
    expect(binaryResult.bytes).toBe(binary);
  });

  it("preserves non-UTF-8 bytes of textual bodies", () => {
    // windows-1251 "Пароль" followed by an ASCII form body.
    const prefix = [0xcf, 0xe0, 0xf0, 0xee, 0xeb, 0xfc, 0x0a];
    const bytes = new Uint8Array([...prefix, ...encoder.encode("password=hunter2")]);
    const result = redactBodyBytes(bytes, PATTERNS, { mimeType: "text/plain" });

    expect(result.redacted).toBe(true);
    expect([...result.bytes.slice(0, prefix.length)]).toEqual(prefix);
    expect(decoder.decode(result.bytes.slice(prefix.length))).toBe(
      `password=${BODY_REDACTION_TOKEN}`
    );
  });

  it("returns empty bodies and empty patterns untouched", () => {
    const empty = new Uint8Array();
    const bytes = encoder.encode("password=1");

    expect(redactBodyBytes(empty, PATTERNS).bytes).toBe(empty);
    expect(redactBodyBytes(bytes, []).redacted).toBe(false);
  });
});

describe("isTextualMimeType", () => {
  it.each([
    ["text/html", true],
    ["application/json", true],
    ["application/problem+json", true],
    ["application/xml", true],
    ["application/javascript", true],
    ["application/ecmascript", true],
    ["application/x-www-form-urlencoded", true],
    ["image/png", false],
    ["application/octet-stream", false]
  ])("%s → %s", (mime, expected) => {
    expect(isTextualMimeType(mime)).toBe(expected);
  });
});
