import { describe, expect, it } from "vitest";

import { documentNode, el, text } from "../test-support/rrweb-fixtures.js";
import {
  elementPath,
  renderDomSubtree,
  textContentOf,
  truncateText,
  utf8Length
} from "./render.js";
import { DomTree } from "./tree.js";

function pageTree(): DomTree {
  const tree = DomTree.fromSnapshot(
    documentNode([
      el(10, "main", { id: "app", class: "page  wide extra more" }, [
        el(11, "h1", {}, [text(12, "Orders & <Returns>")]),
        el(13, "button", { id: "pay", title: 'say "hi"' }, [text(14, "Pay")]),
        el(15, "input", { name: "q" }),
        el(16, "style", {}, [text(17, ".a{color:red}")]),
        el(18, "link", { rel: "stylesheet", _cssText: "x".repeat(5_000) }),
        el(19, "section", {}, [el(20, "div", {}, [el(21, "span", {}, [text(22, "deep text")])])])
      ])
    ])
  );
  tree.applyInput({ id: 15, text: "shoes", isChecked: false });
  return tree;
}

describe("renderDomSubtree (html)", () => {
  it("renders elements with their node ids, escaped text and live field values", () => {
    const { content, truncated, omittedNodeIds } = renderDomSubtree(pageTree(), 10, {
      depth: 5
    });

    expect(content).toContain('<main wb-id="10" id="app" class="page  wide extra more">');
    expect(content).toContain('<h1 wb-id="11">Orders &amp; &lt;Returns&gt;</h1>');
    expect(content).toContain(
      '<button wb-id="13" id="pay" title="say &quot;hi&quot;">Pay</button>'
    );
    expect(content).toContain('<input wb-id="15" name="q" wb-value="shoes" wb-checked="false">');
    expect(content).toContain('<style wb-id="16">/* 13 chars */</style>');
    expect(content).toContain('_csstext="[5000 chars of inlined CSS]"');
    expect(truncated).toBe(false);
    expect(omittedNodeIds).toEqual([]);
  });

  it("summarizes what lies below the depth limit with a drill-down id", () => {
    const { content, omittedNodeIds } = renderDomSubtree(pageTree(), 10, { depth: 1 });

    expect(content).toContain(
      '<section wb-id="19"><!-- 1 child elements, text "deep text"; nodeId=19 --></section>'
    );
    expect(omittedNodeIds).toContain(19);
  });

  it("collapses the head of a document", () => {
    const { content } = renderDomSubtree(pageTree(), 1);

    expect(content.startsWith('<!DOCTYPE html><html wb-id="3">')).toBe(true);
    expect(content).toContain(
      '<head wb-id="4"><!-- 1 elements, title "Test page", 0 stylesheets; nodeId=4 --></head>'
    );
  });

  it("stops at the byte budget, closes what it opened and lists what it cut", () => {
    const { content, truncated, omittedNodeIds, bytes } = renderDomSubtree(pageTree(), 10, {
      maxBytes: 300
    });

    expect(truncated).toBe(true);
    expect(bytes).toBeLessThanOrEqual(320);
    expect(content.endsWith("</main>")).toBe(true);
    expect(omittedNodeIds.length).toBeGreaterThan(0);
  });
});

describe("renderDomSubtree (outline)", () => {
  it("lists elements with ids, text and state, indented by depth", () => {
    const { content } = renderDomSubtree(pageTree(), 10, { format: "outline", depth: 1 });

    expect(content.split("\n")).toEqual([
      "main#app.page.wide.extra [10]",
      '  h1 [11] "Orders & <Returns>"',
      '  button#pay [13] "Pay"',
      '  input [15] value="shoes" checked=false',
      "  style [16]",
      "  link [18]",
      '  section [19] "deep text" (+1 children)',
      ""
    ]);
  });
});

describe("helpers", () => {
  it("builds element paths and text content", () => {
    const tree = pageTree();

    expect(elementPath(tree, 21)).toBe(
      "html > body > main#app.page.wide.extra > section > div > span"
    );
    expect(elementPath(tree, 999)).toBe("");
    expect(textContentOf(tree, 10, 1_000)).toBe("Orders & <Returns>Paydeep text");
    expect(textContentOf(tree, 10, 5)).toBe("Order…");
  });

  it("counts UTF-8 bytes and truncates", () => {
    expect(utf8Length("aé€😀")).toBe(1 + 2 + 3 + 4);
    expect(truncateText("abcdef", 3)).toBe("abc…");
    expect(truncateText("abc", 3)).toBe("abc");
  });
});

describe("renderDomSubtree hardening", () => {
  it("escapes page text inside its own comments", () => {
    const tree = DomTree.fromSnapshot(
      documentNode(
        [el(10, "section", {}, [el(11, "p", {}, [text(12, '--><button wb-id="99">Pay')])])],
        "x --> <b>"
      )
    );

    const deep = renderDomSubtree(tree, 10, { depth: 0 }).content;
    const page = renderDomSubtree(tree, 1).content;

    expect(deep).toContain('text "--&gt;&lt;button wb-id="99"&gt;Pay"');
    expect(deep).not.toContain("<button");
    expect(page).toContain('title "x --&gt; &lt;b&gt;"');
  });

  it("keeps outline lines one per element", () => {
    const tree = DomTree.fromSnapshot(
      documentNode([el(10, "div", { id: "a\nfake [1]" }, [el(11, "input", {})])])
    );
    tree.applyInput({ id: 11, text: "line\nfake [2]", isChecked: false });

    const { content } = renderDomSubtree(tree, 10, { format: "outline" });

    expect(content.trimEnd().split("\n")).toHaveLength(2);
  });
});
