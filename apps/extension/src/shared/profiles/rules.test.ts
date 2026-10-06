import { describe, expect, it } from "vitest";

import type { ProfileRule } from "./model.js";
import {
  collectPageSignalRequest,
  findMatchingRule,
  matchesHostPattern,
  matchesPathGlob,
  matchesRule
} from "./rules.js";

function rule(id: string, match: ProfileRule["match"], priority = 0, enabled = true): ProfileRule {
  return { id, profileId: `p-${id}`, priority, enabled, match };
}

const host = (url: string, pattern: string): boolean => matchesHostPattern(new URL(url), pattern);

describe("matchesHostPattern", () => {
  it("matches exact hosts on any port", () => {
    expect(host("https://app.example.com/x", "app.example.com")).toBe(true);
    expect(host("http://app.example.com:8080/", "app.example.com")).toBe(true);
    expect(host("https://example.com/", "app.example.com")).toBe(false);
    expect(host("https://APP.Example.com/", "app.EXAMPLE.com")).toBe(true);
  });

  it("matches subdomains and the apex for *. patterns", () => {
    expect(host("https://a.stage.example.com/", "*.stage.example.com")).toBe(true);
    expect(host("https://x.a.stage.example.com/", "*.stage.example.com")).toBe(true);
    expect(host("https://stage.example.com/", "*.stage.example.com")).toBe(true);
    expect(host("https://evilstage.example.com/", "*.stage.example.com")).toBe(false);
    expect(host("https://stage.example.com.evil.test/", "*.stage.example.com")).toBe(false);
  });

  it("handles ports, localhost and IPv6", () => {
    expect(host("http://localhost:3000/", "localhost:*")).toBe(true);
    expect(host("http://localhost/", "localhost:*")).toBe(true);
    expect(host("http://localhost:3000/", "localhost:3000")).toBe(true);
    expect(host("http://localhost:3001/", "localhost:3000")).toBe(false);
    expect(host("https://example.com/", "example.com:443")).toBe(true);
    expect(host("http://127.0.0.1:5173/", "127.0.0.1:*")).toBe(true);
    expect(host("http://[::1]:8080/", "[::1]:8080")).toBe(true);
    expect(host("http://[::1]:8081/", "[::1]:8080")).toBe(false);
  });

  it("supports scheme prefixes, origins and the catch-all", () => {
    expect(host("https://app.example.com/", "https://app.example.com")).toBe(true);
    expect(host("http://app.example.com/", "https://app.example.com")).toBe(false);
    expect(host("https://any.test/", "*")).toBe(true);
    expect(host("https://any.test/", "")).toBe(false);
  });
});

describe("matchesPathGlob", () => {
  it("treats * as one segment and ** as many", () => {
    expect(matchesPathGlob("/admin/users", "/admin/*")).toBe(true);
    expect(matchesPathGlob("/admin/users/1", "/admin/*")).toBe(false);
    expect(matchesPathGlob("/admin/users/1", "/admin/**")).toBe(true);
    expect(matchesPathGlob("/admin/", "/admin/**")).toBe(true);
    expect(matchesPathGlob("/administrator", "/admin/**")).toBe(false);
    expect(matchesPathGlob("/a.b", "/a.b")).toBe(true);
    expect(matchesPathGlob("/axb", "/a.b")).toBe(false);
  });
});

describe("matchesRule", () => {
  const page = {
    url: "https://qa.stage.example.com/admin/orders?env=qa&debug",
    title: "Orders — STAGE",
    incognito: false,
    metaTags: { environment: ["qa"] },
    selectorsPresent: { "[data-env='stage']": true }
  };

  it("requires every configured condition", () => {
    expect(
      matchesRule(
        {
          hosts: ["*.stage.example.com"],
          paths: ["/admin/**"],
          query: { env: "qa", debug: true },
          titleRegex: "stage",
          metaTag: { name: "Environment", value: "qa" },
          selectorPresent: "[data-env='stage']",
          incognito: false
        },
        page
      )
    ).toBe(true);
    expect(matchesRule({ hosts: ["*.stage.example.com"], query: { env: "prod" } }, page)).toBe(
      false
    );
    expect(matchesRule({ query: { missing: true } }, page)).toBe(false);
    expect(matchesRule({ incognito: true }, page)).toBe(false);
    expect(matchesRule({ titleRegex: "^prod" }, page)).toBe(false);
    expect(matchesRule({ metaTag: { name: "environment", value: "prod" } }, page)).toBe(false);
    expect(matchesRule({ metaTag: { name: "environment" } }, page)).toBe(true);
  });

  it("fails DOM conditions when signals were not probed", () => {
    const bare = { url: page.url };

    expect(matchesRule({ titleRegex: "stage" }, bare)).toBe(false);
    expect(matchesRule({ selectorPresent: "[data-env='stage']" }, bare)).toBe(false);
    expect(matchesRule({ metaTag: { name: "environment" } }, bare)).toBe(false);
  });

  it("matches everything with an empty match and nothing for bad URLs", () => {
    expect(matchesRule({}, page)).toBe(true);
    expect(matchesRule({}, { url: "not a url" })).toBe(false);
  });
});

describe("findMatchingRule", () => {
  const context = { url: "https://qa.stage.example.com/" };

  it("prefers the highest priority and keeps list order on ties", () => {
    const rules = [
      rule("low", { hosts: ["*.example.com"] }, 1),
      rule("high", { hosts: ["*.stage.example.com"] }, 10),
      rule("tie", { hosts: ["qa.stage.example.com"] }, 10)
    ];

    expect(findMatchingRule(rules, context)?.id).toBe("high");
  });

  it("skips disabled rules and returns undefined without a match", () => {
    expect(findMatchingRule([rule("off", {}, 5, false)], context)).toBeUndefined();
    expect(findMatchingRule([rule("other", { hosts: ["other.test"] })], context)).toBeUndefined();
  });
});

describe("collectPageSignalRequest", () => {
  it("lists DOM signals of enabled rules only", () => {
    expect(
      collectPageSignalRequest([
        rule("a", { metaTag: { name: "Environment" }, titleRegex: "x" }),
        rule("b", { selectorPresent: "#app" }),
        rule("c", { selectorPresent: "#ignored" }, 0, false)
      ])
    ).toEqual({ metaNames: ["environment"], selectors: ["#app"], needsTitle: true });
  });
});
