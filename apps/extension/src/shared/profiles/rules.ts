import type { ProfileRule, ProfileRuleMatch } from "./model.js";
import { isSafeRegexSource, matchesGlob } from "./safe-pattern.js";

/** What the rule engine knows about the page; DOM-derived signals are optional. */
export type ProfilePageContext = {
  url: string;
  title?: string;
  incognito?: boolean;
  /** Lowercased meta name → contents, when probed. */
  metaTags?: Record<string, string[]>;
  /** Selector → present on the page, when probed. */
  selectorsPresent?: Record<string, boolean>;
};

/** Page-side signals a set of rules needs probed from the DOM. */
export type ProfilePageSignalRequest = {
  metaNames: string[];
  selectors: string[];
  needsTitle: boolean;
};

// Short enough that the slowest regex `isSafeRegexSource` accepts stays in the milliseconds.
const MAX_TITLE_LENGTH = 256;
const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "https:": "443",
  "ws:": "80",
  "wss:": "443"
};

/**
 * Picks the enabled rule with the highest priority whose every condition matches the page.
 * Ties keep list order (managed rules come first). Rules `isUsable` rejects (e.g. pointing to a
 * deleted profile) are skipped so they never shadow lower-priority rules. Returns undefined when
 * nothing matches.
 */
export function findMatchingRule(
  rules: readonly ProfileRule[],
  context: ProfilePageContext,
  isUsable: (rule: ProfileRule) => boolean = () => true
): ProfileRule | undefined {
  let best: ProfileRule | undefined;

  for (const rule of rules) {
    if (!rule.enabled || !isUsable(rule) || !matchesRule(rule.match, context)) {
      continue;
    }

    if (!best || rule.priority > best.priority) {
      best = rule;
    }
  }

  return best;
}

/** True when every condition set on `match` holds for the page (an empty match matches all). */
export function matchesRule(match: ProfileRuleMatch, context: ProfilePageContext): boolean {
  const url = safeParseUrl(context.url);

  if (!url) {
    return false;
  }

  if (
    match.hosts &&
    match.hosts.length > 0 &&
    !match.hosts.some((p) => matchesHostPattern(url, p))
  ) {
    return false;
  }

  if (
    match.paths &&
    match.paths.length > 0 &&
    !match.paths.some((p) => matchesPathGlob(url.pathname, p))
  ) {
    return false;
  }

  if (match.query && !matchesQuery(url.searchParams, match.query)) {
    return false;
  }

  if (typeof match.incognito === "boolean" && match.incognito !== (context.incognito === true)) {
    return false;
  }

  if (match.titleRegex !== undefined && !matchesTitle(context.title, match.titleRegex)) {
    return false;
  }

  if (match.metaTag && !matchesMetaTag(context.metaTags, match.metaTag)) {
    return false;
  }

  if (match.selectorPresent && context.selectorsPresent?.[match.selectorPresent] !== true) {
    return false;
  }

  return true;
}

/**
 * Host globs: `example.com` (any port), `*.example.com` (apex and subdomains), `localhost:*`,
 * `127.0.0.1:3000`, `[::1]:8080`, `*` (any host), optionally prefixed by `http://` / `https://`.
 * A bare origin from enterprise allowlists (`https://app.example.com`) works too.
 */
export function matchesHostPattern(url: URL, rawPattern: string): boolean {
  const parsed = parseHostPattern(rawPattern);

  if (!parsed) {
    return false;
  }

  if (parsed.protocol && parsed.protocol !== url.protocol) {
    return false;
  }

  const port = url.port || DEFAULT_PORTS[url.protocol] || "";

  if (parsed.port !== undefined && parsed.port !== "*" && parsed.port !== port) {
    return false;
  }

  const host = url.hostname.toLowerCase();

  if (parsed.host === "*") {
    return true;
  }

  if (parsed.host.startsWith("*.")) {
    const suffix = parsed.host.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }

  return host === parsed.host;
}

/** Path glob: `*` matches within one segment, `**` across segments, everything else is literal. */
export function matchesPathGlob(pathname: string, pattern: string): boolean {
  const trimmed = pattern.trim();

  if (!trimmed) {
    return false;
  }

  return matchesGlob(pathname, trimmed);
}

/** Collects the DOM signals (meta names, selectors, title) any enabled rule depends on. */
export function collectPageSignalRequest(rules: readonly ProfileRule[]): ProfilePageSignalRequest {
  const metaNames = new Set<string>();
  const selectors = new Set<string>();
  let needsTitle = false;

  for (const rule of rules) {
    if (!rule.enabled) {
      continue;
    }

    if (rule.match.metaTag) {
      metaNames.add(rule.match.metaTag.name.toLowerCase());
    }

    if (rule.match.selectorPresent) {
      selectors.add(rule.match.selectorPresent);
    }

    needsTitle ||= rule.match.titleRegex !== undefined;
  }

  return { metaNames: [...metaNames], selectors: [...selectors], needsTitle };
}

type ParsedHostPattern = {
  protocol?: string;
  host: string;
  port?: string;
};

function parseHostPattern(rawPattern: string): ParsedHostPattern | null {
  let pattern = rawPattern.trim().toLowerCase();
  let protocol: string | undefined;
  const schemeMatch = /^([a-z][a-z\d+.-]*):\/\//.exec(pattern);

  if (schemeMatch?.[1]) {
    protocol = `${schemeMatch[1]}:`;
    pattern = pattern.slice(schemeMatch[0].length);
  }

  pattern = pattern.replace(/\/.*$/, "");

  if (!pattern) {
    return null;
  }

  if (pattern.startsWith("[")) {
    const end = pattern.indexOf("]");

    if (end < 0) {
      return null;
    }

    const rest = pattern.slice(end + 1);
    return {
      protocol,
      host: pattern.slice(0, end + 1),
      port: rest.startsWith(":") ? rest.slice(1) : undefined
    };
  }

  const colon = pattern.lastIndexOf(":");

  if (colon >= 0) {
    return { protocol, host: pattern.slice(0, colon), port: pattern.slice(colon + 1) };
  }

  return { protocol, host: pattern };
}

function matchesQuery(params: URLSearchParams, query: Record<string, string | true>): boolean {
  return Object.entries(query).every(([key, expected]) =>
    expected === true ? params.has(key) : params.getAll(key).includes(expected)
  );
}

function matchesTitle(title: string | undefined, regex: string): boolean {
  // Stored rules are validated on read; this also covers rules built in memory.
  if (typeof title !== "string" || !isSafeRegexSource(regex)) {
    return false;
  }

  try {
    return new RegExp(regex, "i").test(title.slice(0, MAX_TITLE_LENGTH));
  } catch {
    return false;
  }
}

function matchesMetaTag(
  metaTags: Record<string, string[]> | undefined,
  expected: { name: string; value?: string }
): boolean {
  const values = metaTags?.[expected.name.toLowerCase()];

  if (!values || values.length === 0) {
    return false;
  }

  return expected.value === undefined || values.includes(expected.value);
}

function safeParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
