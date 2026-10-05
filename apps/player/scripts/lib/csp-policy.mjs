// The Player's Content-Security-Policy lives in the `<meta http-equiv>` of `index.html`. These
// helpers derive the two variants the build and the e2e need from that single source:
// - the dev server policy (Vite's React refresh preamble is an inline module script, HMR uses ws:);
// - the strict policy without `style-src 'unsafe-inline'`, which the React player must already
//   satisfy so that R5 can drop it (no runtime-injected <style> elements).

const CSP_META_PATTERN = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/u;

/** The policy string of the CSP meta tag, or "" when the page has none. */
export function readCsp(html) {
  return html.match(CSP_META_PATTERN)?.[2] ?? "";
}

/** The page with its CSP meta content replaced (the page must already have one). */
export function withCsp(html, policy) {
  if (!CSP_META_PATTERN.test(html)) {
    throw new Error("index.html has no Content-Security-Policy meta tag.");
  }

  return html.replace(CSP_META_PATTERN, (_match, head, _policy, tail) => `${head}${policy}${tail}`);
}

/** Policy text → ordered `[directive, sources[]]` pairs. */
export function parseCsp(policy) {
  return policy
    .split(";")
    .map((part) => part.trim().split(/\s+/u))
    .filter((tokens) => tokens[0])
    .map(([name, ...sources]) => [name.toLowerCase(), sources]);
}

export function serializeCsp(directives) {
  return directives.map(([name, sources]) => [name, ...sources].join(" ")).join("; ");
}

function mapDirective(policy, name, update) {
  return serializeCsp(
    parseCsp(policy).map(([directive, sources]) =>
      directive === name ? [directive, update(sources)] : [directive, sources]
    )
  );
}

function addSource(sources, source) {
  return sources.includes(source) ? sources : [...sources, source];
}

/** Dev server only: allow the inline React refresh preamble and the HMR websocket. */
export function devCsp(policy) {
  const withScript = mapDirective(policy, "script-src", (sources) =>
    addSource(sources, "'unsafe-inline'")
  );
  return mapDirective(withScript, "connect-src", (sources) => addSource(sources, "ws:"));
}

/** The policy without `style-src 'unsafe-inline'`: injected <style> elements are blocked. */
export function strictStyleCsp(policy) {
  return mapDirective(policy, "style-src", (sources) =>
    sources.filter((source) => source !== "'unsafe-inline'")
  );
}
