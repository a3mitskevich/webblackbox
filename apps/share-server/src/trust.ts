import { BlockList, isIP, isIPv4 } from "node:net";
import type { IncomingHttpHeaders } from "node:http";

export type TrustedProxyList = {
  blockList: BlockList;
  size: number;
  invalidEntries: string[];
};

export type ClientAddressInput = {
  socketAddress: string | undefined;
  forwardedFor: string | string[] | undefined;
  trustForwardedFor: boolean;
  trustedProxies: TrustedProxyList;
};

const IPV4_MAPPED_PREFIX = "::ffff:";
const MAX_FORWARDED_HOPS = 32;
const FORWARDING_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip"] as const;
const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "[::1]"] as const;
const WILDCARD_BIND_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

/**
 * Parses a comma separated list of proxy IPs or CIDR ranges (`10.0.0.1, 10.1.0.0/16, fd00::/8`).
 * Invalid entries are skipped and returned so the caller can warn about them.
 */
export function parseTrustedProxies(rawValue: string | undefined): TrustedProxyList {
  const blockList = new BlockList();
  const invalidEntries: string[] = [];
  let size = 0;

  for (const entry of (rawValue ?? "").split(",")) {
    const trimmed = entry.trim();

    if (!trimmed) {
      continue;
    }

    if (addTrustedProxyEntry(blockList, trimmed)) {
      size += 1;
    } else {
      invalidEntries.push(trimmed);
    }
  }

  return { blockList, size, invalidEntries };
}

/**
 * Resolves the address used for rate limiting and audit hashing.
 *
 * Forwarded hops are only consulted when forwarding is trusted AND the socket peer is a configured
 * trusted proxy. The list is walked right to left (each proxy appends the address it saw), skipping
 * trusted proxies, so client-supplied left-most entries can never win over the hop that the nearest
 * trusted proxy observed.
 */
export function resolveClientAddress(input: ClientAddressInput): string | null {
  const socketAddress = normalizeIpAddress(input.socketAddress);

  if (
    !socketAddress ||
    !input.trustForwardedFor ||
    !isTrustedProxy(socketAddress, input.trustedProxies)
  ) {
    return socketAddress;
  }

  const hops = readForwardedForHops(input.forwardedFor);
  let lastTrustedHop = socketAddress;

  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const hop = normalizeIpAddress(hops[index]);

    if (!hop) {
      return lastTrustedHop;
    }

    if (!isTrustedProxy(hop, input.trustedProxies)) {
      return hop;
    }

    lastTrustedHop = hop;
  }

  return lastTrustedHop;
}

export function isTrustedProxy(address: string, trustedProxies: TrustedProxyList): boolean {
  if (trustedProxies.size === 0) {
    return false;
  }

  const family = isIP(address);

  if (family === 0) {
    return false;
  }

  return trustedProxies.blockList.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * Normalizes a socket or forwarded address to a bare IP: strips brackets, ports, zone ids and the
 * IPv4-mapped IPv6 prefix. Returns null for anything that is not an IP address.
 */
export function normalizeIpAddress(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  let candidate = value.trim().toLowerCase();

  if (candidate.startsWith("[")) {
    const closingIndex = candidate.indexOf("]");
    if (closingIndex < 0) {
      return null;
    }
    candidate = candidate.slice(1, closingIndex);
  } else if (/^[0-9.]+:\d+$/.test(candidate)) {
    candidate = candidate.slice(0, candidate.indexOf(":"));
  }

  const zoneIndex = candidate.indexOf("%");
  if (zoneIndex >= 0) {
    candidate = candidate.slice(0, zoneIndex);
  }

  if (candidate.startsWith(IPV4_MAPPED_PREFIX)) {
    const mapped = candidate.slice(IPV4_MAPPED_PREFIX.length);
    if (isIPv4(mapped)) {
      candidate = mapped;
    }
  }

  return isIP(candidate) === 0 ? null : candidate;
}

export function isLoopbackAddress(address: string): boolean {
  const normalized = normalizeIpAddress(address);

  if (!normalized) {
    return false;
  }

  return normalized === "::1" || (isIPv4(normalized) && normalized.startsWith("127."));
}

export function hasForwardingHeaders(headers: IncomingHttpHeaders): boolean {
  return FORWARDING_HEADERS.some((name) => headers[name] !== undefined);
}

/**
 * Keyless mode only serves clients on the same machine. That decision is made from the socket peer
 * alone: forwarding headers can only revoke it (a local reverse proxy relaying a remote client), never
 * grant it.
 */
export function isKeylessLoopbackRequest(
  socketAddress: string | undefined,
  headers: IncomingHttpHeaders
): boolean {
  const address = normalizeIpAddress(socketAddress);
  return Boolean(address && isLoopbackAddress(address) && !hasForwardingHeaders(headers));
}

/**
 * Builds the `Host` allowlist: loopback names, the bind host when it is a specific address, and any
 * extra hostnames (or URLs) from `WEBBLACKBOX_SHARE_ALLOWED_HOSTS`. Ports are ignored.
 */
export function parseAllowedHosts(rawValue: string | undefined, bindHost: string): Set<string> {
  const entries = [
    ...DEFAULT_ALLOWED_HOSTS,
    ...(WILDCARD_BIND_HOSTS.has(bindHost.trim()) ? [] : [bindHost]),
    ...(rawValue ?? "").split(",")
  ];

  return new Set(
    entries
      .map((entry) => normalizeHostname(entry))
      .filter((hostname): hostname is string => hostname !== null)
  );
}

export function isAllowedHostHeader(
  hostHeader: string | undefined,
  allowedHosts: ReadonlySet<string>
): boolean {
  const hostname = normalizeHostname(hostHeader);
  return hostname !== null && allowedHosts.has(hostname);
}

/**
 * Extracts a lower-case hostname (IPv6 kept in brackets, trailing dot removed) from a `Host` header
 * value, a bare hostname, or a URL. Returns null for values that carry credentials or a path.
 */
export function normalizeHostname(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  if (isIP(trimmed) === 6) {
    return `[${trimmed.toLowerCase()}]`;
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;

  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }

  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search) {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  return hostname.length > 0 ? hostname : null;
}

function addTrustedProxyEntry(blockList: BlockList, entry: string): boolean {
  const slashIndex = entry.indexOf("/");

  if (slashIndex < 0) {
    const address = normalizeIpAddress(entry);
    if (!address) {
      return false;
    }
    blockList.addAddress(address, isIPv4(address) ? "ipv4" : "ipv6");
    return true;
  }

  const network = normalizeIpAddress(entry.slice(0, slashIndex));
  const prefixText = entry.slice(slashIndex + 1).trim();

  if (!network || !/^\d{1,3}$/.test(prefixText)) {
    return false;
  }

  const prefix = Number(prefixText);
  const family = isIPv4(network) ? "ipv4" : "ipv6";

  if (prefix > (family === "ipv4" ? 32 : 128)) {
    return false;
  }

  blockList.addSubnet(network, prefix, family);
  return true;
}

function readForwardedForHops(value: string | string[] | undefined): string[] {
  const joined = Array.isArray(value) ? value.join(",") : (value ?? "");
  const hops = joined
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);

  return hops.slice(-MAX_FORWARDED_HOPS);
}
