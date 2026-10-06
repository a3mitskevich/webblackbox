import { createHighlighterCoreSync, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import css from "shiki/langs/css.mjs";
import html from "shiki/langs/html.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import markdown from "shiki/langs/markdown.mjs";
import shellscript from "shiki/langs/shellscript.mjs";
import xml from "shiki/langs/xml.mjs";
import githubDark from "shiki/themes/github-dark-high-contrast.mjs";
import githubLight from "shiki/themes/github-light-high-contrast.mjs";

import type { CodeLanguage } from "./body.js";

/**
 * Shiki, fine-grained (LIBRARIES.md): the JavaScript regex engine (no WebAssembly, no `eval`),
 * static grammars and both GitHub high-contrast themes (WCAG AA on the code background). This module is only reached through a dynamic import,
 * so it ships in its own chunk and loads the first time a body is highlighted.
 */

/** One highlighted run: its text and the CSS variables of both themes (`--shiki-light`, …). */
export type CodeToken = {
  content: string;
  style: Record<string, string>;
};

/** `markdown` is for generated bug reports (its embedded languages load lazily, so never here). */
export type HighlightLanguage = Exclude<CodeLanguage, "plain"> | "shellscript" | "markdown";

let highlighter: HighlighterCore | null = null;

function getHighlighter(): HighlighterCore {
  highlighter ??= createHighlighterCoreSync({
    engine: createJavaScriptRegexEngine(),
    langs: [json, javascript, html, css, xml, shellscript, markdown],
    themes: [githubLight, githubDark]
  });
  return highlighter;
}

/**
 * Lines of tokens for `code`. With `defaultColor: false` every token carries both themes as CSS
 * variables, so switching the theme is pure CSS (no second pass).
 */
export function highlightLines(code: string, language: HighlightLanguage): CodeToken[][] {
  const result = getHighlighter().codeToTokens(code, {
    lang: language,
    themes: { light: "github-light-high-contrast", dark: "github-dark-high-contrast" },
    defaultColor: false
  });

  return result.tokens.map((line) =>
    line.map((token) => ({ content: token.content, style: token.htmlStyle ?? {} }))
  );
}
