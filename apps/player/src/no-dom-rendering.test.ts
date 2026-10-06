import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The Player renders only through React: no HTML strings (archive fields are untrusted) and no
 * hand-built DOM. This test walks the TypeScript AST of every file under `src/` (comments and
 * strings never match) and fails on any construct below that is not in `ALLOWED`.
 */
const HTML_PROPERTIES = new Set([
  "innerHTML",
  "outerHTML",
  "insertAdjacentHTML",
  "insertAdjacentElement",
  "insertAdjacentText",
  "createContextualFragment",
  "setHTMLUnsafe",
  "parseHTMLUnsafe",
  "parseFromString"
]);
const DOCUMENT_BUILDERS = new Set([
  "createElement",
  "createElementNS",
  "createTextNode",
  "createDocumentFragment",
  "write",
  "writeln"
]);
// `append` / `before`… are also names of non-DOM methods (URLSearchParams.append): such a call
// needs an ALLOWED entry with its reason.
const DOM_INSERTION = new Set([
  "appendChild",
  "insertBefore",
  "replaceChild",
  "replaceChildren",
  "append",
  "prepend",
  "before",
  "after",
  "replaceWith"
]);
/** Objects whose builders count as `document.*`: `document`, `x.document`, `x.ownerDocument`. */
const DOCUMENT_NAMES = new Set(["document", "ownerDocument"]);
/** Constructors that parse HTML strings into nodes. */
const HTML_PARSERS = new Set(["DOMParser"]);
const TEXT_PROPERTIES = new Set(["textContent", "innerText", "outerText", "nodeValue"]);

/**
 * The only exceptions, per file (path relative to `src/`) and construct, each with its reason.
 * None of them renders UI.
 */
const ALLOWED: Record<string, Record<string, string>> = {
  "lib/export.ts": {
    // A detached `<a download>` that is clicked and dropped: the standard way to save a Blob.
    "document.createElement": "download anchor"
  },
  "next/features/perf/perf-chart.tsx": {
    // A detached canvas probes for 2D support (jsdom has none); it is never inserted.
    "document.createElement": "canvas support probe"
  },
  "next/features/perf/perf-chart.test.tsx": {
    // The uPlot stub needs an element for its `over` layer, as the real chart has.
    "document.createElement": "uPlot stub element"
  }
};

function nameOf(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }

  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }

  return null;
}

function objectOf(node: ts.Node): ts.Expression | null {
  return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
    ? node.expression
    : null;
}

function isDocument(node: ts.Expression | null | undefined): boolean {
  if (!node) {
    return false;
  }

  const name = ts.isIdentifier(node) ? node.text : nameOf(node);
  return name !== null && DOCUMENT_NAMES.has(name);
}

function isAssignment(node: ts.Node): boolean {
  return (
    ts.isBinaryExpression(node.parent) &&
    node.parent.left === node &&
    node.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}

/**
 * Names that write DOM through other shapes: `{ innerHTML }` / `{ textContent: s }` object
 * literals (`Object.assign(node, …)`), `const { createElement } = document` and
 * `new DOMParser()`.
 */
function indirectHit(node: ts.Node): string | null {
  if (
    (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
    (HTML_PROPERTIES.has(node.name.text) || TEXT_PROPERTIES.has(node.name.text))
  ) {
    return `{${node.name.text}}`;
  }

  if (
    ts.isBindingElement(node) &&
    ts.isObjectBindingPattern(node.parent) &&
    ts.isVariableDeclaration(node.parent.parent) &&
    isDocument(node.parent.parent.initializer)
  ) {
    const name = (node.propertyName ?? node.name).getText();
    return DOCUMENT_BUILDERS.has(name) ? `document.${name}` : null;
  }

  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    HTML_PARSERS.has(node.expression.text)
  ) {
    return `new ${node.expression.text}`;
  }

  return null;
}

/** Every forbidden construct in `source`, as `"<construct>@<line>"`. */
export function findDomRendering(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const at = (node: ts.Node): number =>
    file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

  const visit = (node: ts.Node): void => {
    const name = nameOf(node);

    if (name !== null) {
      if (HTML_PROPERTIES.has(name)) {
        hits.push(`${name}@${at(node)}`);
      } else if (isDocument(objectOf(node)) && DOCUMENT_BUILDERS.has(name)) {
        hits.push(`document.${name}@${at(node)}`);
      } else if (
        DOM_INSERTION.has(name) &&
        ts.isCallExpression(node.parent) &&
        node.parent.expression === node
      ) {
        hits.push(`${name}@${at(node)}`);
      } else if (TEXT_PROPERTIES.has(name) && isAssignment(node)) {
        hits.push(`${name}=@${at(node)}`);
      }
    }

    const indirect = indirectHit(node);

    if (indirect !== null) {
      hits.push(`${indirect}@${at(node)}`);
    }

    if (ts.isJsxAttribute(node) && node.name.getText(file) === "dangerouslySetInnerHTML") {
      hits.push(`dangerouslySetInnerHTML@${at(node)}`);
    }

    ts.forEachChild(node, visit);
  };

  visit(file);
  return hits;
}

const srcDir = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      return sourceFiles(path);
    }

    return /\.(ts|tsx|mts)$/u.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

describe("no innerHTML / manual DOM rendering in the Player", () => {
  it("finds HTML strings, hand-built DOM and text writes, but not comments or strings", () => {
    const planted = [
      "// innerHTML in a comment is fine",
      'const doc = "document.createElement in a string is fine";',
      "node.innerHTML = html;",
      'node["outerHTML"];',
      "node.insertAdjacentHTML('beforeend', html);",
      "document.write(html);",
      'const div = document.createElement("div");',
      "parent.appendChild(div);",
      "parent.replaceChildren();",
      "label.textContent = text;",
      "label.textContent;",
      "const view = <div dangerouslySetInnerHTML={{ __html: html }} />;",
      'const el = node.ownerDocument.createElement("style");',
      "document.head.append(el);",
      "window.document.createTextNode(text);",
      "const { createElement } = document;",
      "Object.assign(el, { textContent: css });",
      'new DOMParser().parseFromString(html, "text/html");',
      "node.setHTMLUnsafe(html);",
      "node.after(other);"
    ].join("\n");

    expect(findDomRendering("planted.tsx", planted)).toEqual([
      "innerHTML@3",
      "outerHTML@4",
      "insertAdjacentHTML@5",
      "document.write@6",
      "document.createElement@7",
      "appendChild@8",
      "replaceChildren@9",
      "textContent=@10",
      "dangerouslySetInnerHTML@12",
      "document.createElement@13",
      "append@14",
      "document.createTextNode@15",
      "document.createElement@16",
      "{textContent}@17",
      "parseFromString@18",
      "new DOMParser@18",
      "setHTMLUnsafe@19",
      "after@20"
    ]);
  });

  it("has no such construct in src/ outside the explained allowlist", () => {
    const files = sourceFiles(srcDir);
    const violations: string[] = [];
    const used = new Set<string>();

    // The scanner's own fixtures above are strings, never code.
    expect(files.length).toBeGreaterThan(50);

    for (const path of files) {
      const rel = relative(srcDir, path).split("\\").join("/");
      const allowed = ALLOWED[rel] ?? {};

      for (const hit of findDomRendering(path, readFileSync(path, "utf8"))) {
        const construct = hit.slice(0, hit.lastIndexOf("@"));

        if (construct in allowed) {
          used.add(`${rel}:${construct}`);
        } else {
          violations.push(`${rel}: ${hit}`);
        }
      }
    }

    expect(violations).toEqual([]);
    // A stale allowlist entry would hide a future call site in that file.
    const unused = Object.entries(ALLOWED).flatMap(([file, constructs]) =>
      Object.keys(constructs)
        .map((construct) => `${file}:${construct}`)
        .filter((key) => !used.has(key))
    );
    expect(unused).toEqual([]);
  });
});
