// The Player's Content-Security-Policy lives in the `<meta http-equiv>` of `index.html`. The
// production policy has no 'unsafe-inline' anywhere (no inline scripts, no runtime-injected
// <style>); only the Vite dev server relaxes it (React refresh preamble, HMR websocket and the CSS
// Vite injects as <style> elements during development).

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

/**
 * Dev server only: allow the inline React refresh preamble, the HMR websocket and the CSS that
 * Vite injects as <style> elements in development (the build ships CSS files instead).
 */
export function devCsp(policy) {
  const withScript = mapDirective(policy, "script-src", (sources) =>
    addSource(sources, "'unsafe-inline'")
  );
  const withStyle = mapDirective(withScript, "style-src", (sources) =>
    addSource(sources, "'unsafe-inline'")
  );
  return mapDirective(withStyle, "connect-src", (sources) => addSource(sources, "ws:"));
}
