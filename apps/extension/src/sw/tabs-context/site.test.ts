import { describe, expect, it } from "vitest";

import { parseTabLocation, registrableDomain, relateTabLocation } from "./site.js";

function relation(recordedUrl: string, candidateUrl: string) {
  const recorded = parseTabLocation(recordedUrl);
  const candidate = parseTabLocation(candidateUrl);

  if (!recorded || !candidate) {
    return "not-http";
  }

  return relateTabLocation(recorded, candidate);
}

describe("registrableDomain", () => {
  it.each([
    ["example.com", "example.com"],
    ["app.example.com", "example.com"],
    ["a.b.c.example.com", "example.com"],
    ["APP.Example.COM.", "example.com"],
    ["shop.example.co.uk", "example.co.uk"],
    ["example.co.uk", "example.co.uk"],
    ["www.example.com.au", "example.com.au"],
    ["api.example.io", "example.io"],
    ["alice.github.io", "alice.github.io"],
    ["docs.alice.github.io", "alice.github.io"],
    ["my-app.vercel.app", "my-app.vercel.app"],
    ["preview.my-app.pages.dev", "my-app.pages.dev"],
    ["localhost", "localhost"],
    ["app.localhost", "app.localhost"],
    ["devbox", "devbox"],
    ["127.0.0.1", "127.0.0.1"],
    ["10.0.0.12", "10.0.0.12"],
    ["[::1]", "[::1]"]
  ])("%s → %s", (host, site) => {
    expect(registrableDomain(host)).toBe(site);
  });
});

describe("relateTabLocation", () => {
  it("matches the same origin and subdomains of the same site", () => {
    expect(relation("https://app.example.com/a", "https://app.example.com/b?q=1")).toBe(
      "same-origin"
    );
    expect(relation("https://app.example.com/", "https://admin.example.com/")).toBe("same-site");
    expect(relation("https://app.example.com/", "https://example.com/")).toBe("same-site");
    expect(relation("https://app.example.com/", "https://example.org/")).toBeNull();
    expect(relation("https://example.com/", "https://notexample.com/")).toBeNull();
  });

  it("treats other ports and schemes of a host as the same site, not the same origin", () => {
    expect(relation("http://localhost:3000/", "http://localhost:3000/x")).toBe("same-origin");
    expect(relation("http://localhost:3000/", "http://localhost:4000/")).toBe("same-site");
    expect(relation("http://example.com/", "https://example.com/")).toBe("same-site");
    expect(relation("http://127.0.0.1:8080/", "http://127.0.0.1:9090/")).toBe("same-site");
  });

  it("never relates different IPs, localhost names or hosting tenants", () => {
    expect(relation("http://127.0.0.1:8080/", "http://127.0.0.2:8080/")).toBeNull();
    expect(relation("http://127.0.0.1:8080/", "http://localhost:8080/")).toBeNull();
    expect(relation("http://localhost:3000/", "http://app.localhost:3000/")).toBeNull();
    expect(relation("https://alice.github.io/", "https://bob.github.io/")).toBeNull();
    expect(relation("https://a.example.co.uk/", "https://b.other.co.uk/")).toBeNull();
    expect(relation("http://[::1]:3000/", "http://[::1]:4000/")).toBe("same-site");
  });

  it("ignores non-http tabs", () => {
    expect(parseTabLocation("chrome://newtab/")).toBeNull();
    expect(parseTabLocation("about:blank")).toBeNull();
    expect(parseTabLocation("file:///tmp/a.html")).toBeNull();
    expect(parseTabLocation("chrome-extension://abc/popup.html")).toBeNull();
    expect(parseTabLocation("not a url")).toBeNull();
    expect(parseTabLocation(undefined)).toBeNull();
  });

  it("keeps the path and query but not the fragment", () => {
    expect(parseTabLocation("https://app.example.com/orders/7?tab=2#top")).toEqual({
      origin: "https://app.example.com",
      site: "example.com",
      path: "/orders/7?tab=2"
    });
  });
});
