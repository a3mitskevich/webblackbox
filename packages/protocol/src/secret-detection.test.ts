import { describe, expect, it } from "vitest";

import {
  containsCredential,
  foldSecretText,
  isTokenShaped,
  mentionsSecretName,
  redactCredentials,
  unescapeForScan
} from "./secret-detection.js";
import { growthRatio, LINEAR_GROWTH_LIMIT } from "./test-support/linear-growth.js";

// Real formats, assembled at runtime so secret scanners do not flag this source.
const join = (...parts: string[]): string => parts.join("");
const CREDENTIALS = {
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJlLXZhbHVlLTE",
  bearer: "Bearer abcdefghijklmnop.qrstuvwx",
  basic: "Basic dXNlcjpwYXNzd29yZA==",
  pem: "-----BEGIN RSA PRIVATE KEY-----",
  stripe: join("sk_", "live_", "51HxQ2eKmT9vYbR3nLp8wZaC"),
  github: join("gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"),
  aws: join("AK", "IA", "Z7Q2XK4MNB5RT8WP"),
  slack: join("xo", "xb-", "2741-883921-QwErTyUiOpAs"),
  google: join("AI", "za", "SyD3x9Kq7_Lm2Np4Rt6Vw8Yz0Ab1Cd2Ef3G"),
  gitlab: join("gl", "pat-", "Xy7Zq2Wv4Ut6Sr8Qp0On"),
  openai: join("sk", "-proj-", "Ab3Cd5Ef7Gh9Ij1Kl3Mn5Op"),
  npm: join("np", "m_", "a".repeat(18), "1".repeat(18)),
  hex: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  base62: "q8Zt3Lm9Xw2Rv7Kp4Nd6",
  base64url: "oHtmr-lAc6KRN_ofgVW0Eb4q_BSs5GbCvqHPmMvlAtg",
  base64: "/rF/qS9xfuDvY2LNmFA4"
};

describe("containsCredential", () => {
  it.each(Object.entries(CREDENTIALS))("finds a %s anywhere in text", (_name, credential) => {
    expect(containsCredential(`value: ${credential};`)).toBe(true);
    expect(redactCredentials(`value: ${credential};`)).not.toContain(credential);
  });

  it("leaves words, ids and short codes alone", () => {
    for (const text of [
      "Basic settings",
      "orderSummaryRow12",
      "550e8400-e29b-41d4-a716-446655440000",
      "checkout_submit_button_primary_variant",
      "product_card_12345_title_wrapper",
      "orderSummaryRow12_mobileVariant3",
      "/static/js/main-chunk-vendors.js",
      "Internationalization2024",
      "Order 42 shipped on 2024-05-01",
      "#a1b2c3"
    ]) {
      expect(containsCredential(text), text).toBe(false);
      expect(redactCredentials(text), text).toBe(text);
    }
  });

  it("stays linear on adversarial runs", () => {
    // Growth, not an absolute budget, so parallel load cannot fail the test.
    for (const [unit, count] of [
      ["a-eyJ", 6_000],
      ["xoxb-", 20_000],
      ["Bearer x-", 2_200],
      ["Basic ", 3_300],
      ["a1", 40_000]
    ] as const) {
      const ratio = growthRatio((scale) => {
        const text = unit.repeat(count * scale);

        return () => {
          containsCredential(text);
          redactCredentials(text);
        };
      });

      expect(ratio, unit).toBeLessThan(LINEAR_GROWTH_LIMIT);
    }
  });
});

describe("isTokenShaped", () => {
  it("needs a long mixed run, or many letter/digit changes in a shorter one", () => {
    expect(isTokenShaped("a8F3k2Lm9Q1x7Z4p0Rt5")).toBe(true);
    expect(isTokenShaped("abcdefghijklmnopqrstuvwxyz012345")).toBe(true);
    expect(isTokenShaped("productCard12345Title")).toBe(false);
    expect(isTokenShaped("abcdefghijklmnopqrstuvwxyzabcdef")).toBe(false);
  });
});

describe("mentionsSecretName", () => {
  it("matches run-together, camel-case and folded Unicode names", () => {
    for (const name of [
      "JSESSIONID",
      "oauthState",
      "data-csrftoken",
      "accessJwt",
      "x_api_key",
      "ſession",
      "ＴＯＫＥＮ",
      "SESSİON",
      "sessıon",
      "authOrigin",
      "Authorization",
      "pin",
      "card_cvv",
      "data-sig"
    ]) {
      expect(mentionsSecretName(name), name).toBe(true);
    }
  });

  it("keeps words that only contain a short secret name", () => {
    for (const name of ["sidebar", "spinner", "hotpath", "authorName", "author", "design"]) {
      expect(mentionsSecretName(name), name).toBe(false);
    }
  });

  it("accepts extra parts such as a profile's body patterns", () => {
    expect(mentionsSecretName("customerSecretSauce", ["sauce"])).toBe(true);
    expect(mentionsSecretName("x_private_key", ["private_key"])).toBe(true);
  });
});

describe("text folding and unescaping", () => {
  it("folds lookalikes and decodes JSON and URL escapes", () => {
    expect(foldSecretText("ＴＯＫＥＮ ſession SESSİON")).toBe("token session session");
    const backslash = "\\";
    const escaped = `{"${backslash}u0074oken":1, "${backslash.repeat(3)}u0073id":2}`;

    expect(unescapeForScan(escaped)).toBe('{"token":1, "sid":2}');
    expect(unescapeForScan("%7B%22token%22%3A1%7D")).toBe('{"token":1}');
  });

  it("unescapes long backslash runs and splits long capital runs in linear time", () => {
    for (const [unit, count, scan] of [
      ["\\", 20_000, (text: string) => unescapeForScan(text)],
      ["A", 5_000, (text: string) => mentionsSecretName(text)]
    ] as const) {
      const ratio = growthRatio((scale) => {
        const text = unit.repeat(count * scale);

        return () => scan(text);
      });

      expect(ratio, unit).toBeLessThan(LINEAR_GROWTH_LIMIT);
    }
  });
});
