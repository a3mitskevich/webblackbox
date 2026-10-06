import { basename } from "node:path";

const CONTENT_SCRIPT_CHUNK = "content.js";

/**
 * Wraps a classic-script bundle in its own function scope. Without it every top-level `var` of
 * the bundle lives in the isolated world's global scope, so a second run of the same file (the
 * registered copy plus one injected on Start or after a navigation) re-initializes the running
 * copy's state before the script's own guard can stop it. The prefix stays on line 1, so source
 * map lines keep matching.
 *
 * @param {string} code
 * @returns {string}
 */
export function wrapInScriptScope(code) {
  return `(() => {${code}\n})();\n`;
}

/**
 * tsup plugin: gives `content.js` (bundled as ESM, executed as a classic content script) its own
 * scope. Other entries are left alone; `content-agent.js` must stay an ES module.
 *
 * @returns {{ name: string, renderChunk(code: string, chunk: { path: string }): { code: string } | undefined }}
 */
export function contentScriptScopePlugin() {
  return {
    name: "content-script-scope",
    renderChunk(code, chunk) {
      return basename(chunk.path) === CONTENT_SCRIPT_CHUNK
        ? { code: wrapInScriptScope(code) }
        : undefined;
    }
  };
}
