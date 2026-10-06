import type { HighlighterCore } from "shiki/core";

/** One highlighted span: the light-theme colour and the dark-theme colour. */
export type HighlightToken = { content: string; color?: string; darkColor?: string };

export type HighlightLanguage = "javascript" | "typescript";

/** Source above this size is shown as plain text (LIBRARIES.md: synchronous highlighting cap). */
export const MAX_HIGHLIGHT_CHARS = 64 * 1024;

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, HighlightLanguage>> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  vue: "typescript",
  svelte: "typescript"
};

let highlighter: Promise<HighlighterCore> | null = null;

/** The grammar for a source path, or `null` when it is not JavaScript or TypeScript. */
export function languageOf(path: string): HighlightLanguage | null {
  const clean = path.replace(/[?#].*$/u, "");
  const extension = /\.([a-z]+)$/iu.exec(clean)?.[1]?.toLowerCase();
  return extension ? (LANGUAGE_BY_EXTENSION[extension] ?? null) : null;
}

/**
 * Shiki, fine-grained: the core with the JavaScript regex engine (no WebAssembly, no `eval`),
 * two grammars and the GitHub light and dark themes. Loaded in its own chunk on first use.
 */
export function loadHighlighter(): Promise<HighlighterCore> {
  highlighter ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/langs/javascript.mjs"),
    import("shiki/langs/typescript.mjs"),
    import("shiki/themes/github-light-high-contrast.mjs"),
    import("shiki/themes/github-dark-high-contrast.mjs")
  ]).then(([core, engine, javascript, typescript, light, dark]) =>
    core.createHighlighterCoreSync({
      themes: [light.default, dark.default],
      langs: [javascript.default, typescript.default],
      engine: engine.createJavaScriptRegexEngine()
    })
  );
  highlighter.catch(() => {
    highlighter = null;
  });
  return highlighter;
}

/** Tokens per line, or `null` when the code is too large to highlight here. */
export async function highlightLines(
  code: string,
  language: HighlightLanguage
): Promise<HighlightToken[][] | null> {
  if (code.length > MAX_HIGHLIGHT_CHARS) {
    return null;
  }

  const core = await loadHighlighter();
  const result = core.codeToTokens(code, {
    lang: language,
    themes: { light: "github-light-high-contrast", dark: "github-dark-high-contrast" }
  });

  return result.tokens.map((line) =>
    line.map((token) => {
      const style = token.htmlStyle as Record<string, string> | undefined;
      const color = style?.color;
      const darkColor = style?.["--shiki-dark"];

      return {
        content: token.content,
        ...(color ? { color } : {}),
        ...(darkColor ? { darkColor } : {})
      };
    })
  );
}
