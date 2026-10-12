import { describe, expect, it } from "vitest";

import { documentNode, el, text } from "../test-support/rrweb-fixtures.js";
import { renderDomSubtree } from "./render.js";
import { applyStyleChanges, DOM_TREE_MAX_DEPTH, DomTree } from "./tree.js";

const html = (tree: DomTree, id = tree.rootId!) =>
  renderDomSubtree(tree, id, { collapseHead: false, depth: 50 }).content.replace(
    / wb-id="\d+"/g,
    ""
  );

function sampleTree(): DomTree {
  return DomTree.fromSnapshot(
    documentNode([el(10, "ul", { id: "list" }, [el(11, "li", {}, [text(12, "one")])])])
  );
}

describe("DomTree.fromSnapshot", () => {
  it("rebuilds the document with rrweb's ids", () => {
    const tree = sampleTree();

    expect(tree.rootId).toBe(1);
    expect(tree.get(11)).toMatchObject({ kind: "element", tagName: "li", parentId: 10 });
    expect(html(tree)).toBe(
      '<!DOCTYPE html><html><head><title>Test page</title></head><body><ul id="list"><li>one</li></ul></body></html>'
    );
  });

  it("reads attribute values as the DOM holds them", () => {
    const tree = DomTree.fromSnapshot(
      documentNode([el(10, "input", { disabled: true, maxlength: 4, hidden: false, title: null })])
    );

    expect(tree.get(10)?.attributes).toEqual({ disabled: "", maxlength: "4" });
  });

  it("skips malformed nodes, duplicate ids and subtrees beyond the depth limit", () => {
    const deep = Array.from({ length: DOM_TREE_MAX_DEPTH + 5 }).reduce<Record<string, unknown>>(
      (child, _, index) => el(10_000 + index, "div", {}, [child]),
      text(9_999, "bottom")
    );
    const tree = DomTree.fromSnapshot(
      documentNode([el(10, "p", {}, [{ type: "x", id: 11 }, text(7, "duplicate id")]), deep])
    );

    expect(tree.get(10)?.children).toEqual([]);
    expect(tree.has(9_999)).toBe(false);
    expect(tree.dropped).toBeGreaterThan(0);
    expect(DomTree.fromSnapshot(null).rootId).toBeNull();
  });
});

describe("DomTree.applyMutation", () => {
  it("places adds before their next sibling, waiting for siblings added later in the batch", () => {
    const tree = sampleTree();
    const stats = tree.applyMutation({
      adds: [
        // Arrives first but goes before 21, which is added after it.
        { parentId: 10, nextId: 21, node: el(20, "li", {}, [text(30, "zero")]) },
        { parentId: 10, nextId: 11, node: el(21, "li", {}, [text(31, "half")]) },
        { parentId: 10, nextId: null, node: el(22, "li", {}, [text(32, "two")]) }
      ]
    });

    expect(stats).toEqual({ applied: 3, skipped: 0 });
    expect(html(tree, 10)).toBe(
      '<ul id="list"><li>zero</li><li>half</li><li>one</li><li>two</li></ul>'
    );
  });

  it("uses the previous sibling when there is no next one, and moves re-added nodes", () => {
    const tree = sampleTree();
    tree.applyMutation({
      adds: [
        { parentId: 10, nextId: null, previousId: 11, node: el(20, "li", {}, [text(30, "b")]) }
      ]
    });
    // rrweb records a move as an add of an id that is still in the tree.
    tree.applyMutation({
      adds: [{ parentId: 10, nextId: 11, node: el(20, "li", {}, [text(30, "b")]) }]
    });

    expect(html(tree, 10)).toBe('<ul id="list"><li>b</li><li>one</li></ul>');
  });

  it("removes subtrees, changes texts and attributes, and drops orphans", () => {
    const tree = sampleTree();
    const stats = tree.applyMutation({
      removes: [
        { parentId: 10, id: 11 },
        { parentId: 10, id: 999 }
      ],
      adds: [
        { parentId: 10, nextId: null, node: el(40, "li", { class: "new" }, [text(41, "x")]) },
        { parentId: 777, nextId: null, node: el(42, "li") }
      ],
      texts: [
        { id: 41, value: "changed" },
        { id: 10, value: "not a text node" }
      ],
      attributes: [
        { id: 40, attributes: { class: null, "data-state": "open", style: "color: red" } },
        { id: 40, attributes: { style: { color: false, display: ["none", "important"] } } },
        { id: 12345, attributes: { a: "b" } }
      ]
    });

    expect(tree.has(12)).toBe(false);
    expect(tree.get(40)?.attributes).toEqual({
      "data-state": "open",
      style: "display: none !important"
    });
    expect(html(tree, 10)).toBe(
      '<ul id="list"><li data-state="open" style="display: none !important">changed</li></ul>'
    );
    expect(stats).toEqual({ applied: 5, skipped: 4 });
    expect(tree.dropped).toBe(1);
  });

  it("ignores malformed mutation data", () => {
    const tree = sampleTree();

    expect(tree.applyMutation(null)).toEqual({ applied: 0, skipped: 0 });
    expect(
      tree.applyMutation({ adds: [{ parentId: "x" }, 5], removes: "all", texts: [{ id: 1.5 }] })
    ).toEqual({ applied: 0, skipped: 0 });
    expect(tree.size).toBe(sampleTree().size);
  });

  it("applies field input to elements only", () => {
    const tree = DomTree.fromSnapshot(documentNode([el(10, "input"), text(11, "t")]));

    expect(tree.applyInput({ id: 10, text: "typed", isChecked: true })).toBe(true);
    expect(tree.applyInput({ id: 11, text: "no" })).toBe(false);
    expect(tree.applyInput({ id: "10" })).toBe(false);
    expect(tree.get(10)).toMatchObject({ value: "typed", checked: true });
  });

  it("reports ancestors nearest first", () => {
    const tree = sampleTree();

    expect(tree.ancestors(12).map((node) => node.id)).toEqual([11, 10, 7, 3, 1]);
  });
});

describe("applyStyleChanges", () => {
  it("sets, replaces and removes declarations", () => {
    expect(
      applyStyleChanges("color: red; margin: 0", {
        color: "blue",
        margin: false,
        padding: ["1px", ""],
        width: ["2px", "important"],
        ignored: 3
      })
    ).toBe("color: blue; padding: 1px; width: 2px !important");
  });

  it("keeps semicolons inside url() and strings, and the case of custom properties", () => {
    expect(
      applyStyleChanges('background: url(data:image/png;base64,AAA); content: ";"; --Brand: red', {
        color: "blue"
      })
    ).toBe('background: url(data:image/png;base64,AAA); content: ";"; --Brand: red; color: blue');
  });
});

describe("DomTree hardening", () => {
  it("drops attribute names and replaces tag names that could break the rendered markup", () => {
    const tree = DomTree.fromSnapshot(
      documentNode([
        el(10, 'div><b wb-id="1"', { 'x><b wb-id="2"': "a", title: "ok" }, [text(11, "t")])
      ])
    );

    expect(html(tree, 10)).toBe('<wb-invalid-tag title="ok">t</wb-invalid-tag>');
  });

  it("removes a parent with more children than a spread call can take", () => {
    const children = Array.from({ length: 150_000 }, (_, index) => el(100 + index, "i", {}));
    const tree = DomTree.fromSnapshot(documentNode([el(10, "div", {}, children)]));

    tree.applyMutation({ removes: [{ parentId: 7, id: 10 }], adds: [], texts: [], attributes: [] });

    expect(tree.has(10)).toBe(false);
    expect(tree.has(100)).toBe(false);
  });
});
