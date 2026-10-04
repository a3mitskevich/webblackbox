/**
 * Adversarial corpus for storage values recorded under `storage: allow`: real-world layouts and
 * hostile encodings with planted secrets. Every planted secret must be absent from the output,
 * with the default lists and with a profile that narrowed them.
 */
import { DEFAULT_REDACTION_PROFILE, type RedactionProfile } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import { redactPayload } from "./redaction.js";

const DEFAULT_PROFILE: RedactionProfile = {
  ...DEFAULT_REDACTION_PROFILE,
  hashSensitiveValues: false
};
/** A custom profile that emptied its lists: the content checks must hold on their own. */
const NARROWED_PROFILE: RedactionProfile = {
  ...DEFAULT_PROFILE,
  redactHeaders: [],
  redactCookieNames: [],
  redactBodyPatterns: []
};
const BACKSLASH = "\\";

// Real formats, assembled at runtime so secret scanners do not flag this source.
const join = (...parts: string[]): string => parts.join("");
const STRIPE = join("sk_", "live_", "51HxQ2eKmT9vYbR3nLp8wZaC");
const GITHUB = join("gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8");
const AWS = join("AK", "IA", "Z7Q2XK4MNB5RT8WP");
const SLACK = join("xo", "xb-", "2741-883921-QwErTyUiOpAs");
const GOOGLE = join("AI", "za", "SyD3x9Kq7_Lm2Np4Rt6Vw8Yz0Ab1Cd2Ef3G");
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJlLXZhbHVlLTE";
const DIGEST = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

type StorageCase = { key: string; value: string; secret: string };

/** More fields than a field-name scan used to read, still under the 2 KiB value cap. */
const manyFields = Object.fromEntries(Array.from({ length: 210 }, (_, index) => [`f${index}`, 0]));

const CASES: StorageCase[] = [
  // Real SDK layouts.
  {
    key: "@@auth0spajs@@::client::https://api.test::openid profile",
    value: JSON.stringify({ body: { access_token: "AUTH0SECRET", expires_in: 86400 } }),
    secret: "AUTH0SECRET"
  },
  {
    key: "firebase:authUser:AIzaKey:[DEFAULT]",
    value: JSON.stringify({ stsTokenManager: { refreshToken: "FIREBASESECRET" } }),
    secret: "FIREBASESECRET"
  },
  {
    key: "msal.2f1c.idtoken",
    value: JSON.stringify({ secret: "MSALSECRET", credentialType: "IdToken" }),
    secret: "MSALSECRET"
  },
  {
    key: "sb-abcd-auth-token",
    value: '{"access_token":"SUPABASESECRET"}',
    secret: "SUPABASESECRET"
  },
  {
    key: "CognitoIdentityServiceProvider.app.user.accessToken",
    value: "COGNITOSECRET",
    secret: "COGNITOSECRET"
  },
  // Innocuous keys, secrets nested or encoded in the value.
  {
    key: "persist:root",
    value: JSON.stringify({ auth: JSON.stringify({ token: "DOUBLESECRET" }) }),
    secret: "DOUBLESECRET"
  },
  {
    key: "state",
    value: JSON.stringify({ a: JSON.stringify({ b: JSON.stringify({ sid: "TRIPLESECRET" }) }) }),
    secret: "TRIPLESECRET"
  },
  {
    key: "cache",
    value: `{"${BACKSLASH}u0074oken":"UNICODEESCAPESECRET"}`,
    secret: "UNICODEESCAPESECRET"
  },
  {
    key: "cache2",
    value: JSON.stringify({ [`${"x".repeat(70)}_sessionId`]: "LONGNAMESECRET" }),
    secret: "LONGNAMESECRET"
  },
  {
    key: "cache3",
    value: JSON.stringify({ ...manyFields, sessionId: "LATEFIELDSECRET" }),
    secret: "LATEFIELDSECRET"
  },
  { key: "cache4", value: '{"my session":"SPACESECRET"}', secret: "SPACESECRET" },
  { key: "cache5", value: '{"x:sessionId":"COLONSECRET"}', secret: "COLONSECRET" },
  { key: "query", value: "a=1&sessionId=QUERYSTRINGSECRET", secret: "QUERYSTRINGSECRET" },
  { key: "literal", value: "{sessionId:'OBJECTLITERALSECRET'}", secret: "OBJECTLITERALSECRET" },
  { key: "xml", value: "<sessionId>XMLSECRET</sessionId>", secret: "XMLSECRET" },
  {
    key: "encoded",
    value: encodeURIComponent('{"token":"URLENCODEDSECRET"}'),
    secret: "URLENCODEDSECRET"
  },
  { key: "pinned", value: '{"pin":"PINSECRET"}', secret: "PINSECRET" },
  { key: "payment", value: '{"cvv":"CVVSECRET"}', secret: "CVVSECRET" },
  // Unicode lookalike key names.
  { key: "ſession", value: "LONGSSECRET", secret: "LONGSSECRET" },
  { key: "ＴＯＫＥＮ", value: "FULLWIDTHSECRET", secret: "FULLWIDTHSECRET" },
  { key: "SESSİON", value: "DOTTEDSECRET", secret: "DOTTEDSECRET" },
  { key: "cfg", value: '{"ＴＯＫＥＮ":"FULLWIDTHFIELDSECRET"}', secret: "FULLWIDTHFIELDSECRET" },
  // Credentials under keys that say nothing.
  { key: "cfg1", value: STRIPE, secret: STRIPE },
  { key: "cfg2", value: GITHUB, secret: GITHUB },
  { key: "cfg3", value: AWS, secret: AWS },
  { key: "cfg4", value: SLACK, secret: SLACK },
  { key: "cfg5", value: GOOGLE, secret: GOOGLE },
  { key: "cfg6", value: DIGEST, secret: DIGEST },
  { key: "cfg7", value: JSON.stringify({ id: JWT }), secret: JWT },
  {
    key: "cfg8",
    value: JSON.stringify({ header: `Bearer ${"q".repeat(30)}` }),
    secret: "q".repeat(30)
  }
];

describe("storage value corpus", () => {
  for (const [label, profile] of [
    ["default lists", DEFAULT_PROFILE],
    ["narrowed lists", NARROWED_PROFILE]
  ] as const) {
    it.each(CASES)(`${label}: masks $key`, ({ key, value, secret }) => {
      expect(value.length).toBeLessThanOrEqual(2_048);
      expect(decodeURIComponent(value)).toContain(secret);

      const op = redactPayload({ op: "setItem", key, value }, profile);
      const snapshot = redactPayload({ entries: [{ key, value }] }, profile);

      expect(JSON.stringify(op)).not.toContain(secret);
      expect(JSON.stringify(snapshot)).not.toContain(secret);
    });
  }

  it("scans hostile values in linear time", () => {
    for (const value of ["A".repeat(200_000), `{${"Ab".repeat(100_000)}}`, "%".repeat(200_000)]) {
      const started = performance.now();

      redactPayload({ op: "setItem", key: "k", value }, DEFAULT_PROFILE);

      expect(performance.now() - started, value.slice(0, 4)).toBeLessThan(1_000);
    }
  });

  it("keeps ordinary app state readable", () => {
    const entries = [
      { key: "theme", value: "dark" },
      { key: "sidebarOpen", value: "true" },
      { key: "cart", value: JSON.stringify({ items: [{ sku: "A-1", qty: 2 }] }) },
      { key: "prefs", value: JSON.stringify({ author: "Ann", locale: "de-DE" }) },
      { key: "recent", value: "550e8400-e29b-41d4-a716-446655440000" }
    ];

    const redacted = redactPayload({ entries }, DEFAULT_PROFILE) as { entries: typeof entries };

    expect(redacted.entries).toEqual(entries);
  });
});
