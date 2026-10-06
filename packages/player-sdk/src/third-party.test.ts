import { describe, expect, it } from "vitest";

import { isThirdPartyUrl, registrableDomain, siteKeyOf } from "./third-party.js";

describe("registrableDomain", () => {
  it("keeps the last two labels", () => {
    expect(registrableDomain("app.example.test")).toBe("example.test");
    expect(registrableDomain("a.b.cdn.example.com.")).toBe("example.com");
    expect(registrableDomain("Example.COM")).toBe("example.com");
  });

  it("keeps three labels under a multi-label public suffix", () => {
    expect(registrableDomain("www.shop.co.uk")).toBe("shop.co.uk");
    expect(registrableDomain("alice.github.io")).toBe("alice.github.io");
  });

  it("keeps IPs and single labels whole", () => {
    expect(registrableDomain("127.0.0.1")).toBe("127.0.0.1");
    expect(registrableDomain("[::1]")).toBe("[::1]");
    expect(registrableDomain("localhost")).toBe("localhost");
  });
});

describe("siteKeyOf", () => {
  it("puts http and ws URLs of one registrable domain on one site", () => {
    expect(siteKeyOf("https://app.example.test/a")).toBe("web://example.test");
    expect(siteKeyOf("wss://live.example.test/hubs")).toBe("web://example.test");
  });

  it("uses the inner origin of blob URLs and the origin of extension URLs", () => {
    expect(siteKeyOf("blob:https://app.example.test/1234")).toBe("web://example.test");
    expect(siteKeyOf("chrome-extension://abc/content.js")).toBe("chrome-extension://abc");
  });

  it("has no site for relative, data, about and unparsable URLs", () => {
    expect(siteKeyOf("/api/user")).toBeNull();
    expect(siteKeyOf("data:text/plain,hi")).toBeNull();
    expect(siteKeyOf("about:blank")).toBeNull();
    expect(siteKeyOf("not a url")).toBeNull();
  });
});

describe("isThirdPartyUrl", () => {
  const origin = "https://app.example.test";

  it("treats subdomains of the recorded site as first-party", () => {
    expect(isThirdPartyUrl("https://cdn.example.test/x.js", origin)).toBe(false);
    expect(isThirdPartyUrl("wss://app.example.test/hubs", origin)).toBe(false);
  });

  it("marks other sites and browser extensions as third-party", () => {
    expect(isThirdPartyUrl("https://www.google-analytics.com/g/collect", origin)).toBe(true);
    expect(isThirdPartyUrl("chrome-extension://abc/inject.js", origin)).toBe(true);
  });

  it("never marks URLs without a site, or anything when the first party is unknown", () => {
    expect(isThirdPartyUrl("/relative", origin)).toBe(false);
    expect(isThirdPartyUrl("data:image/png;base64,AA", origin)).toBe(false);
    expect(isThirdPartyUrl("https://other.test/", "")).toBe(false);
  });
});
