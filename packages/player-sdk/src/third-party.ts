/**
 * Public suffixes of more than one label that the site key recognises: a small, stable subset of
 * the Public Suffix List (country second-level domains and shared hosting platforms where every
 * subdomain is a different owner). Anything else uses the last two labels.
 */
const MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  "ac.uk",
  "co.uk",
  "gov.uk",
  "me.uk",
  "org.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "co.kr",
  "com.br",
  "com.cn",
  "net.cn",
  "org.cn",
  "com.hk",
  "com.tw",
  "com.sg",
  "com.tr",
  "com.ua",
  "com.mx",
  "com.ar",
  "com.pl",
  "co.in",
  "co.il",
  "co.za",
  "appspot.com",
  "azurewebsites.net",
  "blogspot.com",
  "cloudfront.net",
  "firebaseapp.com",
  "github.io",
  "gitlab.io",
  "herokuapp.com",
  "netlify.app",
  "pages.dev",
  "vercel.app",
  "web.app",
  "workers.dev"
]);

const EXTENSION_PROTOCOLS = new Set([
  "chrome-extension:",
  "moz-extension:",
  "safari-web-extension:"
]);
const WEB_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** The registrable domain ("eTLD+1") of a host, or the host itself for IPs and single labels. */
export function registrableDomain(host: string): string {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");

  if (normalized.startsWith("[") || IPV4_PATTERN.test(normalized)) {
    return normalized;
  }

  const labels = normalized.split(".").filter(Boolean);

  if (labels.length <= 2) {
    return labels.join(".");
  }

  const lastTwo = labels.slice(-2).join(".");
  return MULTI_LABEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

/**
 * The site a URL belongs to: `web://<registrable domain>` for web URLs (http and ws share a
 * site), the extension origin for browser-extension URLs, the inner origin of a `blob:` URL.
 * `null` when the URL has no site (relative, `data:`, `about:`, unparsable).
 */
export function siteKeyOf(url: string): string | null {
  const parsed = parseUrl(url);

  if (!parsed) {
    return null;
  }

  if (parsed.protocol === "blob:") {
    return siteKeyOf(parsed.pathname);
  }

  if (EXTENSION_PROTOCOLS.has(parsed.protocol)) {
    return `${parsed.protocol}//${parsed.host}`;
  }

  if (!WEB_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) {
    return null;
  }

  return `web://${registrableDomain(parsed.hostname)}`;
}

/**
 * Whether a resource URL is third-party for the recorded page (PROPOSAL §4: by eTLD+1 of the
 * recording origin). Subdomains of the recorded site (`cdn.example.test` for `app.example.test`)
 * are first-party; browser-extension resources are always third-party. A URL without a site
 * (relative, `data:`) and an unknown first-party URL never count as third-party.
 */
export function isThirdPartyUrl(url: string, firstPartyUrl: string): boolean {
  const site = siteKeyOf(url);
  const firstPartySite = siteKeyOf(firstPartyUrl);
  return site !== null && firstPartySite !== null && site !== firstPartySite;
}
