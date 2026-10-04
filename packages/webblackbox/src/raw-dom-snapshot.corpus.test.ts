/* @vitest-environment jsdom */

/**
 * Adversarial corpus for the raw DOM snapshot: realistic and hostile pages with planted secrets.
 * Every planted secret must be absent from the output, wherever it sits.
 */
import { afterEach, describe, expect, it } from "vitest";

import { sanitizeCss, serializeRawDom } from "./raw-dom-snapshot.js";

const OPTIONS = { blockedSelectors: [".secret"], keepInputValues: true };
const BACKSLASH = "\\";
/** CSS with `\` written as `~` (escapes are hard to read inside template strings). */
const css = (text: string): string => text.replaceAll("~", BACKSLASH);

// Real formats, assembled at runtime so secret scanners do not flag this source.
const join = (...parts: string[]): string => parts.join("");
const STRIPE = join("sk_", "live_", "51HxQ2eKmT9vYbR3nLp8wZaC");
const GITHUB = join("gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8");
const AWS = join("AK", "IA", "Z7Q2XK4MNB5RT8WP");
const SLACK = join("xo", "xb-", "2741-883921-QwErTyUiOpAs");
const GOOGLE = join("AI", "za", "SyD3x9Kq7_Lm2Np4Rt6Vw8Yz0Ab1Cd2Ef3G");
const GITLAB = join("gl", "pat-", "Xy7Zq2Wv4Ut6Sr8Qp0On");
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJlLXZhbHVlLTE";
const DIGEST = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const SSH_KEY_LINE = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ";

type CssCase = { name: string; css: string; secrets: string[]; kept?: string[] };

const CSS_CASES: CssCase[] = [
  {
    name: "Tailwind arbitrary values in escaped selectors",
    css: css(
      ".bg-~[url~(~'~/a~.png~?token~=TW1SECRET~'~)~]{background-image:url('/a.png?token=TW2SECRET')}" +
        ".content-~[~'~?~'~]{content:'?'}"
    ),
    secrets: ["TW1SECRET", "TW2SECRET"],
    kept: ["content:'?'"]
  },
  {
    name: "minified CSS with @import, font-face and upper-case URL(",
    css:
      "@import url(https://fonts.example/css2?family=Inter&key=MIN1SECRET);" +
      '@import "/theme.css?v=1&sig=MIN2SECRET";.a{background:url(/x.png?sig=MIN3SECRET)}' +
      '.b{background:URL( "/y.png?sig=MIN4SECRET" )}@font-face{font-family:x;' +
      'src:url(/fonts/inter.woff?v=4.7.0) format("woff2"),url("/f.woff?token=MIN5SECRET") format("woff")}',
    secrets: ["MIN1SECRET", "MIN2SECRET", "MIN3SECRET", "MIN4SECRET", "MIN5SECRET"],
    kept: ['format("woff2")', "url(/fonts/inter.woff)", "font-family:x"]
  },
  {
    name: "comments holding quotes and queries",
    css:
      `/* don't "quote */ .c{background:url(/z.png?t=CMT1SECRET)} /* ?token=CMT2SECRET */` +
      ` /* it's ' */ .d{background:url('/w.png?t=CMT3SECRET')}`,
    secrets: ["CMT1SECRET", "CMT2SECRET", "CMT3SECRET"],
    kept: [".d{background:url('/w.png')}"]
  },
  {
    name: "escaped url( and hex-escaped query characters",
    css: css(
      ".e{background:u~rl(https://h.test/a.png?token=ESC1SECRET)}" +
        ".f{background:~75 rl(https://h.test/a.png?token=ESC2SECRET)}" +
        ".g{background:url(/a.png~3f token=HEX1SECRET)}" +
        '.h{background:url("/a.png~3f sig~3d HEX2SECRET")}' +
        ".i{background:url(/a.png#t~3d HEX3SECRET)}"
    ),
    secrets: ["ESC1SECRET", "ESC2SECRET", "HEX1SECRET", "HEX2SECRET", "HEX3SECRET"]
  },
  {
    name: "a newline ending a string before a URL",
    css: '.a{content:"abc\n}.b{background:url(/p.png?token=NL1SECRET)}.c{content:"x"}',
    secrets: ["NL1SECRET"]
  },
  {
    name: "malformed URLs with parentheses, quotes and no close",
    css:
      ".a{background:url(/b.png?q=(1)&token=PAREN1SECRET)}" +
      ".b{background:url(/a'b.png?t=QUOTE1SECRET)}" +
      ".c{background:url(/c.png?t=OPEN1SECRET",
    secrets: ["PAREN1SECRET", "QUOTE1SECRET", "OPEN1SECRET"]
  },
  {
    name: "custom properties and strings naming or holding secrets",
    css: `:root{--api-token:"CPROP1SECRET";--stripe:${STRIPE};--brand:#ff0}.k::after{content:"${JWT}"}`,
    secrets: ["CPROP1SECRET", STRIPE, JWT],
    kept: ["--brand:#ff0"]
  },
  {
    name: "data URLs, which may embed markup",
    css:
      ".i{background:url(data:image/svg+xml,<svg><text>DATA1SECRET</text></svg>)}" +
      `.j{background:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><text>DATA2SECRET</text></svg>")}`,
    secrets: ["DATA1SECRET", "DATA2SECRET"]
  },
  {
    name: "signed CDN URLs",
    css:
      '.s3{background:url("https://bucket.s3.amazonaws.com/a.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
      '&X-Amz-Credential=AMZCRED1SECRET&X-Amz-Signature=AMZSIG1SECRET")}' +
      ".cf{background:url(https://d1.cloudfront.net/i.png?Expires=1700000000&Signature=CFSIG1SECRET~&Key-Pair-Id=CFKP1SECRET)}" +
      ".ix{background:image-set('https://x.imgix.net/a.jpg?w=10&s=IMGIX1SECRET' 1x)}",
    secrets: ["AMZCRED1SECRET", "AMZSIG1SECRET", "CFSIG1SECRET", "CFKP1SECRET", "IMGIX1SECRET"],
    kept: ["https://bucket.s3.amazonaws.com/a.jpg"]
  },
  {
    name: "URL credentials and vendor keys in comments",
    css: `.u{background:url(https://user:USERINFO1SECRET@cdn.test/a.png)} /* ftp://admin:USERINFO2SECRET@files.test ${GITHUB} */`,
    secrets: ["USERINFO1SECRET", "USERINFO2SECRET", GITHUB]
  }
];

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.title = "";
});

describe("raw DOM corpus: CSS", () => {
  it.each(CSS_CASES)("$name", ({ css: text, secrets, kept = [] }) => {
    const sanitized = sanitizeCss(text);

    for (const secret of secrets) {
      expect(sanitized, secret).not.toContain(secret);
    }

    for (const fragment of kept) {
      expect(sanitized, fragment).toContain(fragment);
    }

    // The same text inside a page, both as a stylesheet and inline.
    document.body.innerHTML = "<style></style><div>x</div>";
    document.querySelector("style")!.textContent = text;
    document.querySelector("div")!.setAttribute("style", text);
    const html = serializeRawDom(document, OPTIONS)?.html ?? "";

    for (const secret of secrets) {
      expect(html, secret).not.toContain(secret);
    }
  });

  it("keeps ordinary stylesheets readable", () => {
    const ordinary =
      "@font-face{unicode-range:U+0000-00FF}.x{color:#fff;background:url(/img/logo.png) no-repeat}" +
      'a[href^="/docs"]:hover{text-decoration:underline}.btn::before{content:"Next ›"}';

    expect(sanitizeCss(ordinary)).toBe(ordinary);
  });

  it("never lets style text close its element", () => {
    document.body.innerHTML = "<style></style>";
    document.querySelector("style")!.textContent = "</style><img src=x onerror=alert(1)>";

    const html = serializeRawDom(document, OPTIONS)?.html ?? "";

    expect(html).not.toContain("</style><img");
  });
});

describe("raw DOM corpus: attributes", () => {
  it("removes secrets carried by names, values, JSON state and embedded URLs", () => {
    const escapedJson = `{"${BACKSLASH}u0074oken":"ESCAPED1SECRET"}`;
    document.head.innerHTML = `
      <meta name="description" http-equiv="refresh" content="0;url=https://h.test/x?token=META1SECRET">
      <link rel="stylesheet" href="https://cdn.test/app.css?sig=LINK1SECRET">`;
    document.body.innerHTML = `
      <div id="state"
        data-config='{"apiKey":"APIKEY1SECRET"}'
        data-props='{"user":{"name":"Al"},"accessKeyId":"KEYID1SECRET"}'
        data-fold='{"ＴＯＫＥＮ":"FW1SECRET","SESSİON":"DOT1SECRET"}'
        data-key="${STRIPE}" data-gh="${GITHUB}" data-aws="${AWS}" data-slack="${SLACK}"
        data-g="${GOOGLE}" data-gl="${GITLAB}" data-blob="${JWT}"
        aria-label="Your key: ${STRIPE}" title="digest ${DIGEST}"
        data-oauth="OAUTH1SECRET" data-bearer="BEARER1SECRET" data-cookie="COOKIE1SECRET"
        data-totp="TOTP1SECRET" data-sig="SIG1SECRET" data-dsn="DSN1SECRET" data-pin="PIN1SECRET"
        data-url="reset?token=REL1SECRET" data-next="foo.html?code=REL2SECRET"
        longdesc="d?token=REL3SECRET" data-share="Visit https://h.test/x?t=MID1SECRET now"
        onfocusin="f('HANDLER1SECRET')"
        data-bg2="u${BACKSLASH}rl(https://h.test/a.png?token=ESC3SECRET)"
        data-bg3="image-set('/a.png?t=SET1SECRET' 1x)"
        data-login="https://admin:USERINFO3SECRET@h.test/">x</div>
      <img srcset="/a.png?a=1,SRCSET1SECRET 1x, /b.png?sig=SRCSET2SECRET 2x" src="/c.png">
      <a href="reset?token=HREF1SECRET">r</a>
      <a href="javascript:fetch('/x?token=JS1SECRET')">j</a>
      <form action="/cb?code=FORM1SECRET"></form>`;
    document.getElementById("state")!.setAttribute("data-escaped", escapedJson);
    document.getElementById("state")!.setAttribute("data-ſession", "LONGS1SECRET");

    const html = serializeRawDom(document, OPTIONS)?.html ?? "";

    for (const secret of [
      "META1SECRET",
      "LINK1SECRET",
      "APIKEY1SECRET",
      "KEYID1SECRET",
      "ESCAPED1SECRET",
      "FW1SECRET",
      "DOT1SECRET",
      "LONGS1SECRET",
      STRIPE,
      GITHUB,
      AWS,
      SLACK,
      GOOGLE,
      GITLAB,
      JWT,
      DIGEST,
      "OAUTH1SECRET",
      "BEARER1SECRET",
      "COOKIE1SECRET",
      "TOTP1SECRET",
      "SIG1SECRET",
      "DSN1SECRET",
      "PIN1SECRET",
      "REL1SECRET",
      "REL2SECRET",
      "REL3SECRET",
      "MID1SECRET",
      "HANDLER1SECRET",
      "ESC3SECRET",
      "SET1SECRET",
      "USERINFO3SECRET",
      "SRCSET1SECRET",
      "SRCSET2SECRET",
      "HREF1SECRET",
      "JS1SECRET",
      "FORM1SECRET"
    ]) {
      expect(html, secret).not.toContain(secret);
    }

    expect(html).toContain('data-share="Visit https://h.test/x now"');
  });

  it("keeps field values only for fields that are not secret, even with inputs allowed", () => {
    document.body.innerHTML = `
      <input type="text" name="api_key" value="APIFIELD1SECRET">
      <input type="text" name="authToken" value="APIFIELD2SECRET">
      <input type="text" id="csrfField" value="APIFIELD3SECRET">
      <input type="hidden " value="HIDDEN1SECRET">
      <input name="cardnumber" value="4111111111111111">
      <input name="card_cvv" value="CVV1SECRET">
      <input name="pin" value="PINFIELD1SECRET">
      <input name="note" value="${JWT}">
      <textarea name="notes">token ${STRIPE}</textarea>
      <input name="city" value="Berlin">`;

    const html = serializeRawDom(document, OPTIONS)?.html ?? "";

    for (const secret of [
      "APIFIELD1SECRET",
      "APIFIELD2SECRET",
      "APIFIELD3SECRET",
      "HIDDEN1SECRET",
      "4111111111111111",
      "CVV1SECRET",
      "PINFIELD1SECRET",
      JWT,
      STRIPE
    ]) {
      expect(html, secret).not.toContain(secret);
    }

    expect(html).toContain('value="Berlin"');
  });

  it("keeps ordinary attributes and ids", () => {
    document.body.innerHTML = `
      <button class="btn btn-primary" data-testid="checkout-submit" aria-label="Really? yes"
        data-row="orderSummaryRow12" data-id="550e8400-e29b-41d4-a716-446655440000"
        title="Basic settings" id="radix-:r1:">Pay</button>
      <a href="/products/shoes">Shoes</a>`;

    const html = serializeRawDom(document, OPTIONS)?.html ?? "";

    for (const fragment of [
      'class="btn btn-primary"',
      'data-testid="checkout-submit"',
      'aria-label="Really? yes"',
      'data-row="orderSummaryRow12"',
      'data-id="550e8400-e29b-41d4-a716-446655440000"',
      'title="Basic settings"',
      'href="/products/shoes"'
    ]) {
      expect(html, fragment).toContain(fragment);
    }
  });
});

describe("raw DOM corpus: text", () => {
  it("masks credentials and URL queries in visible text, raw-text elements and JSON blocks", () => {
    const escapedJson = `{"${BACKSLASH}u0074oken":"PRE2SECRET"}`;
    document.title = `Reset ${JWT}`;
    document.body.innerHTML = `
      <p>Your API key: ${STRIPE}</p>
      <code>${GITHUB}</code>
      <pre id="state">{"access_token":"PRE1SECRET"}</pre>
      <pre id="escaped"></pre>
      <a href="/r">https://h.test/reset?token=TEXT1SECRET</a>
      <output>Bearer TEXTBEARER1SECRETvalue1234567</output>
      <iframe>IFRAME1SECRET</iframe>
      <xmp>XMP1SECRET</xmp>
      <noembed>NOEMBED1SECRET</noembed>
      <p>-----BEGIN OPENSSH PRIVATE KEY----- ${SSH_KEY_LINE}</p>
      <p>login https://admin:USERINFO4SECRET@h.test/</p>
      <p>Session expired? Sign in again.</p>`;
    document.getElementById("escaped")!.textContent = escapedJson;

    const html = serializeRawDom(document, OPTIONS)?.html ?? "";

    for (const secret of [
      JWT,
      STRIPE,
      GITHUB,
      "PRE1SECRET",
      "PRE2SECRET",
      "TEXT1SECRET",
      "TEXTBEARER1SECRET",
      "IFRAME1SECRET",
      "XMP1SECRET",
      "NOEMBED1SECRET",
      SSH_KEY_LINE,
      "USERINFO4SECRET"
    ]) {
      expect(html, secret).not.toContain(secret);
    }

    expect(html).toContain("Your API key: [REDACTED]");
    expect(html).toContain("https://h.test/reset</a>");
    expect(html).toContain("Session expired? Sign in again.");
  });

  it("never serializes shadow roots, and sanitizes declarative shadow templates", () => {
    document.body.innerHTML = `
      <div id="host"></div>
      <template shadowrootmode="open"><a href="/x?token=DSD1SECRET">x</a></template>`;
    document
      .getElementById("host")!
      .attachShadow({ mode: "open" })
      .append(document.createTextNode("SHADOW1SECRET"));

    const html = serializeRawDom(document, OPTIONS)?.html ?? "";

    expect(html).not.toContain("SHADOW1SECRET");
    expect(html).not.toContain("DSD1SECRET");
  });

  it("stays linear on large hostile pages", () => {
    const hostile = [
      "?a".repeat(100_000),
      "#a".repeat(100_000),
      `${BACKSLASH}#`.repeat(100_000),
      "--".repeat(100_000),
      "a://".repeat(50_000),
      "url(".repeat(50_000)
    ];

    for (const text of hostile) {
      document.body.innerHTML = "<style></style><p></p>";
      document.querySelector("style")!.textContent = text;
      document.querySelector("p")!.textContent = text;
      document.querySelector("p")!.setAttribute("data-x", text);
      const started = performance.now();

      serializeRawDom(document, OPTIONS);

      expect(performance.now() - started, text.slice(0, 6)).toBeLessThan(1_500);
    }
  });
});
