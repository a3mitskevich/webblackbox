import { describe, expect, it } from "vitest";

import {
  hasForwardingHeaders,
  isAllowedHostHeader,
  isKeylessLoopbackRequest,
  isLoopbackAddress,
  normalizeHostname,
  normalizeIpAddress,
  parseAllowedHosts,
  parseTrustedProxies,
  resolveClientAddress
} from "./trust.js";

const PROXY = "10.0.0.5";

function resolve(
  socketAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  options: { trust?: boolean; proxies?: string } = {}
): string | null {
  return resolveClientAddress({
    socketAddress,
    forwardedFor,
    trustForwardedFor: options.trust ?? true,
    trustedProxies: parseTrustedProxies(options.proxies ?? PROXY)
  });
}

describe("parseTrustedProxies", () => {
  it("accepts IPs and CIDR ranges and reports invalid entries", () => {
    const list = parseTrustedProxies(" 10.0.0.5, 172.16.0.0/12 ,fd00::/8, nope, 10.0.0.0/33,, ");

    expect(list.size).toBe(3);
    expect(list.invalidEntries).toEqual(["nope", "10.0.0.0/33"]);
  });

  it("defaults to an empty list", () => {
    expect(parseTrustedProxies(undefined).size).toBe(0);
  });
});

describe("resolveClientAddress", () => {
  it("uses the right-most hop appended by the trusted proxy, not the spoofed left-most one", () => {
    expect(resolve(PROXY, "127.0.0.1, 203.0.113.7")).toBe("203.0.113.7");
  });

  it("skips chained trusted proxies when walking right to left", () => {
    expect(resolve("10.0.0.5", "1.1.1.1, 198.51.100.4, 10.1.2.3", { proxies: "10.0.0.0/8" })).toBe(
      "198.51.100.4"
    );
  });

  it("joins repeated X-Forwarded-For headers", () => {
    expect(resolve(PROXY, ["127.0.0.1", "203.0.113.9"])).toBe("203.0.113.9");
  });

  it("ignores forwarded hops when no trusted proxies are configured", () => {
    expect(resolve("198.51.100.1", "127.0.0.1", { proxies: "" })).toBe("198.51.100.1");
  });

  it("ignores forwarded hops when the socket peer is not a trusted proxy", () => {
    expect(resolve("198.51.100.1", "127.0.0.1")).toBe("198.51.100.1");
  });

  it("ignores forwarded hops when forwarding trust is disabled", () => {
    expect(resolve(PROXY, "203.0.113.7", { trust: false })).toBe(PROXY);
  });

  it("falls back to the last trusted hop on an unparsable entry", () => {
    expect(resolve(PROXY, "203.0.113.7, not-an-ip")).toBe(PROXY);
    expect(resolve("10.0.0.5", "203.0.113.7, garbage, 10.0.0.9", { proxies: "10.0.0.0/24" })).toBe(
      "10.0.0.9"
    );
  });

  it("uses the left-most hop when every hop is a trusted proxy", () => {
    expect(resolve("10.0.0.5", "10.0.0.7, 10.0.0.6", { proxies: "10.0.0.0/24" })).toBe("10.0.0.7");
  });

  it("uses the socket address when X-Forwarded-For is missing", () => {
    expect(resolve(PROXY, undefined)).toBe(PROXY);
  });

  it("normalizes IPv4-mapped socket addresses and ported hops", () => {
    expect(resolve(`::ffff:${PROXY}`, "203.0.113.7:51234")).toBe("203.0.113.7");
    expect(resolve("fd00::1", "[2001:db8::2]:443", { proxies: "fd00::/8" })).toBe("2001:db8::2");
  });

  it("returns null without a usable socket address", () => {
    expect(resolve(undefined, "203.0.113.7")).toBeNull();
  });
});

describe("address helpers", () => {
  it("normalizes IP forms", () => {
    expect(normalizeIpAddress(" ::FFFF:127.0.0.1 ")).toBe("127.0.0.1");
    expect(normalizeIpAddress("[::1]:8080")).toBe("::1");
    expect(normalizeIpAddress("fe80::1%eth0")).toBe("fe80::1");
    expect(normalizeIpAddress("localhost")).toBeNull();
    expect(normalizeIpAddress("")).toBeNull();
  });

  it("detects loopback addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.8.9.10")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.evil.example")).toBe(false);
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
  });

  it("detects forwarding headers", () => {
    expect(hasForwardingHeaders({})).toBe(false);
    expect(hasForwardingHeaders({ "x-forwarded-for": "127.0.0.1" })).toBe(true);
    expect(hasForwardingHeaders({ forwarded: "for=127.0.0.1" })).toBe(true);
    expect(hasForwardingHeaders({ "x-real-ip": "127.0.0.1" })).toBe(true);
  });
});

describe("isKeylessLoopbackRequest", () => {
  it("grants loopback sockets without forwarding headers", () => {
    expect(isKeylessLoopbackRequest("127.0.0.1", {})).toBe(true);
    expect(isKeylessLoopbackRequest("::ffff:127.0.0.1", {})).toBe(true);
  });

  it("never grants based on forwarding headers", () => {
    expect(isKeylessLoopbackRequest("203.0.113.7", { "x-forwarded-for": "127.0.0.1" })).toBe(false);
    expect(isKeylessLoopbackRequest("127.0.0.1", { "x-forwarded-for": "127.0.0.1" })).toBe(false);
    expect(isKeylessLoopbackRequest("127.0.0.1", { "x-real-ip": "127.0.0.1" })).toBe(false);
  });

  it("rejects remote and unknown sockets", () => {
    expect(isKeylessLoopbackRequest("203.0.113.7", {})).toBe(false);
    expect(isKeylessLoopbackRequest(undefined, {})).toBe(false);
  });
});

describe("Host allowlist", () => {
  it("allows loopback names by default and the specific bind host", () => {
    const allowed = parseAllowedHosts(undefined, "192.168.1.20");

    expect([...allowed].sort()).toEqual(["127.0.0.1", "192.168.1.20", "[::1]", "localhost"]);
  });

  it("does not add wildcard bind hosts", () => {
    expect([...parseAllowedHosts(undefined, "0.0.0.0")].sort()).toEqual([
      "127.0.0.1",
      "[::1]",
      "localhost"
    ]);
    expect(parseAllowedHosts(undefined, "::").has("[::]")).toBe(false);
  });

  it("adds configured hosts and URLs, ignoring ports and case", () => {
    const allowed = parseAllowedHosts(
      "Share.Example.com, https://blackbox.example.org:8443/, bad/path",
      "::1"
    );

    expect(allowed.has("share.example.com")).toBe(true);
    expect(allowed.has("blackbox.example.org")).toBe(true);
    expect(allowed.has("[::1]")).toBe(true);
    expect(allowed.size).toBe(5);
  });

  it("matches Host headers by hostname", () => {
    const allowed = parseAllowedHosts("share.example.com", "127.0.0.1");

    expect(isAllowedHostHeader("127.0.0.1:8787", allowed)).toBe(true);
    expect(isAllowedHostHeader("LOCALHOST:8787", allowed)).toBe(true);
    expect(isAllowedHostHeader("[::1]:8787", allowed)).toBe(true);
    expect(isAllowedHostHeader("share.example.com.", allowed)).toBe(true);
  });

  it("rejects rebinding and malformed Host headers", () => {
    const allowed = parseAllowedHosts(undefined, "127.0.0.1");

    expect(isAllowedHostHeader("attacker.example:8787", allowed)).toBe(false);
    expect(isAllowedHostHeader("localhost.attacker.example", allowed)).toBe(false);
    expect(isAllowedHostHeader("user@localhost", allowed)).toBe(false);
    expect(isAllowedHostHeader("localhost/evil", allowed)).toBe(false);
    expect(isAllowedHostHeader("", allowed)).toBe(false);
    expect(isAllowedHostHeader(undefined, allowed)).toBe(false);
  });

  it("normalizes hostnames", () => {
    expect(normalizeHostname("::1")).toBe("[::1]");
    expect(normalizeHostname("http://Example.COM:80")).toBe("example.com");
    expect(normalizeHostname("example.com?x=1")).toBeNull();
  });
});
