import type { RelatedTabRelation } from "@webblackbox/protocol";

/** An http(s) tab URL reduced to what site matching and the archive need. */
export type TabLocation = {
  origin: string;
  /** Registrable domain (eTLD+1); the host itself for IPs and single-label hosts. */
  site: string;
  /** Path and query; the fragment is dropped (in-page anchors are not navigations). */
  path: string;
};

/**
 * Public suffixes with more than one label that hosting platforms or registries hand out to
 * unrelated owners. Not the full Public Suffix List (kept out of the bundle on purpose): a host
 * under a multi-part suffix missing here is grouped too broadly, e.g. two tenants of an unlisted
 * PaaS domain look same-site. Their origins still tell them apart.
 */
const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  "amplifyapp.com",
  "appspot.com",
  "azurestaticapps.net",
  "azurewebsites.net",
  "blogspot.com",
  "cloudfront.net",
  "fly.dev",
  "firebaseapp.com",
  "github.io",
  "gitlab.io",
  "glitch.me",
  "herokuapp.com",
  "loca.lt",
  "myshopify.com",
  "netlify.app",
  "ngrok-free.app",
  "ngrok.app",
  "ngrok.io",
  "onrender.com",
  "pages.dev",
  "railway.app",
  "surge.sh",
  "trycloudflare.com",
  "vercel.app",
  "web.app",
  "workers.dev"
]);

/** Second-level labels that country registries use as public suffixes (`co.uk`, `com.au`). */
const COUNTRY_SECOND_LEVEL_LABELS = new Set([
  "ac",
  "co",
  "com",
  "edu",
  "gob",
  "go",
  "gov",
  "ltd",
  "mil",
  "ne",
  "net",
  "or",
  "org",
  "plc"
]);

const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const COUNTRY_CODE_PATTERN = /^[a-z]{2}$/;

/** `url` as a tab location, or null for anything but http(s) (new tab, chrome://, file:, ...). */
export function parseTabLocation(url: string | undefined): TabLocation | null {
  if (!url) {
    return null;
  }

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
    return null;
  }

  return {
    origin: parsed.origin,
    site: registrableDomain(parsed.hostname),
    path: `${parsed.pathname}${parsed.search}`
  };
}

/**
 * Registrable domain of a host (eTLD+1). Scheme and port never matter for a site, as for cookies.
 * IP addresses and single-label hosts (`localhost`, intranet names) are their own site.
 */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "");

  if (host.startsWith("[") || host.includes(":") || IPV4_PATTERN.test(host)) {
    return host;
  }

  const labels = host.split(".").filter((label) => label.length > 0);

  if (labels.length <= 2) {
    return labels.join(".");
  }

  const suffixLength = publicSuffixLength(labels);
  return labels.slice(-Math.min(labels.length, suffixLength + 1)).join(".");
}

/** How `candidate` relates to the recorded tab's location, or null when it is another site. */
export function relateTabLocation(
  recorded: TabLocation,
  candidate: TabLocation
): RelatedTabRelation | null {
  if (candidate.origin === recorded.origin) {
    return "same-origin";
  }

  return candidate.site === recorded.site ? "same-site" : null;
}

/** Labels in the longest known public suffix of `labels` (at least the top-level domain). */
function publicSuffixLength(labels: readonly string[]): number {
  for (let start = 0; start < labels.length - 1; start += 1) {
    if (MULTI_LABEL_PUBLIC_SUFFIXES.has(labels.slice(start).join("."))) {
      return labels.length - start;
    }
  }

  const topLevel = labels[labels.length - 1] ?? "";
  const secondLevel = labels[labels.length - 2] ?? "";

  return COUNTRY_CODE_PATTERN.test(topLevel) && COUNTRY_SECOND_LEVEL_LABELS.has(secondLevel)
    ? 2
    : 1;
}
