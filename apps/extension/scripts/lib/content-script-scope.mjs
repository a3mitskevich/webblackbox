import { basename } from "node:path";

/**
 * Bundles that Chrome runs as classic scripts although tsup emits them as ESM:
 * - `content.js`, the content script (isolated world);
 * - `injected.js`, the page hooks injected with `scripting.executeScript({ world: "MAIN", files })`.
 */
export const CLASSIC_SCRIPT_CHUNKS = Object.freeze(["content.js", "injected.js"]);

const WRAPPER_PREFIX = "(() => {";
const WRAPPER_SUFFIX = "\n})();\n";
// tsup appends the source map comment after `renderChunk`, i.e. after the wrapper.
const TRAILING_SOURCE_MAP_COMMENT = /\/\/# sourceMappingURL=\S+\s*$/;

/**
 * Wraps a classic-script bundle in its own function scope. Without it every top-level `var`,
 * `function` and `class` of the bundle becomes a global of the world it runs in:
 * - in the isolated world a second run of the same file (the registered copy plus one injected on
 *   Start or after a navigation) re-initializes the running copy's state before the script's own
 *   guard can stop it;
 * - in the page's MAIN world the minified names (`$`, `N`, `_t`…) overwrite the page's own globals,
 *   e.g. jQuery's `$`.
 * The prefix stays on line 1, so source map lines keep matching.
 *
 * @param {string} code
 * @returns {string}
 */
export function wrapInScriptScope(code) {
  return `${WRAPPER_PREFIX}${code}${WRAPPER_SUFFIX}`;
}

/**
 * Whether a built bundle is wrapped by {@link wrapInScriptScope}, so it declares nothing at the top
 * level of the world it runs in.
 *
 * @param {string} code
 * @returns {boolean}
 */
export function isWrappedInScriptScope(code) {
  const body = code.replace(TRAILING_SOURCE_MAP_COMMENT, "");
  return body.startsWith(WRAPPER_PREFIX) && body.endsWith(WRAPPER_SUFFIX);
}

/**
 * tsup plugin: gives every {@link CLASSIC_SCRIPT_CHUNKS} bundle its own scope. Other entries are
 * left alone; `content-agent.js` must stay an ES module.
 *
 * @returns {{ name: string, renderChunk(code: string, chunk: { path: string }): { code: string } | undefined }}
 */
export function contentScriptScopePlugin() {
  return {
    name: "content-script-scope",
    renderChunk(code, chunk) {
      return CLASSIC_SCRIPT_CHUNKS.includes(basename(chunk.path))
        ? { code: wrapInScriptScope(code) }
        : undefined;
    }
  };
}
