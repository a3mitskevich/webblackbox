import { describe, expect, it } from "vitest";

import { documentNode, el, text } from "../test-support/rrweb-fixtures.js";
import { captureDomView, diffDomViews } from "./diff.js";
import { DomTree } from "./tree.js";

function before(): DomTree {
  return DomTree.fromSnapshot(
    documentNode([
      el(10, "ul", {}, [
        el(11, "li", { class: "a" }, [text(12, "one")]),
        el(13, "li", {}, [text(14, "two")])
      ]),
      el(15, "input", { name: "q" }),
      el(16, "p", {}, [text(17, "status: idle")])
    ])
  );
}

describe("diffDomViews", () => {
  it("reports added and removed subtrees, attribute, text and value changes by id", () => {
    const tree = before();
    const start = captureDomView(tree);
    tree.applyMutation({
      removes: [{ parentId: 10, id: 13 }],
      adds: [
        { parentId: 10, nextId: null, node: el(20, "li", { class: "new" }, []) },
        { parentId: 20, nextId: null, node: text(21, "three") }
      ],
      texts: [{ id: 17, value: "status: saved" }],
      attributes: [{ id: 11, attributes: { class: "a selected" } }]
    });
    tree.applyInput({ id: 15, text: "shoes" });

    const diff = diffDomViews(start, captureDomView(tree));

    expect(diff.matchedBy).toBe("id");
    expect(diff.added).toEqual([
      { nodeId: 20, path: "html > body > ul > li.new", label: "li.new", text: "three" }
    ]);
    expect(diff.removed).toEqual([
      { nodeId: 13, path: "html > body > ul > li", label: "li", text: "two" }
    ]);
    expect(diff.attributes).toEqual([
      {
        nodeId: 11,
        path: "html > body > ul > li.a.selected",
        changes: [{ name: "class", before: "a", after: "a selected" }]
      }
    ]);
    expect(diff.texts).toEqual([
      { nodeId: 17, path: "html > body > p", before: "status: idle", after: "status: saved" }
    ]);
    expect(diff.values).toEqual([
      { nodeId: 15, path: "html > body > input", before: null, after: "shoes" }
    ]);
    expect(diff.counts).toEqual({ added: 1, removed: 1, attributes: 1, texts: 1, values: 1 });
    expect(diff.truncated).toBe(false);
  });

  it("matches by structure when rrweb restarted with new ids in between", () => {
    const start = captureDomView(before());
    const restarted = DomTree.fromSnapshot({
      type: 0,
      id: 101,
      childNodes: [
        el(103, "html", {}, [
          el(104, "head", {}, []),
          el(107, "body", {}, [
            el(110, "ul", {}, [el(111, "li", { class: "a" }, [text(112, "one")])]),
            el(115, "input", { name: "q" }),
            el(116, "p", {}, [text(117, "status: done")]),
            el(118, "footer", {}, [text(119, "new")])
          ])
        ])
      ]
    });

    const diff = diffDomViews(start, captureDomView(restarted));

    expect(diff.matchedBy).toBe("path");
    expect(diff.removed.map((change) => change.label)).toEqual(["li", "title"]);
    expect(diff.added.map((change) => change.label)).toEqual(["footer"]);
    expect(diff.texts).toEqual([
      { nodeId: 116, path: "html > body > p", before: "status: idle", after: "status: done" }
    ]);
  });

  it("caps each list but keeps exact counts", () => {
    const tree = before();
    const start = captureDomView(tree);
    tree.applyMutation({
      adds: Array.from({ length: 5 }, (_, index) => ({
        parentId: 10,
        nextId: null,
        node: el(200 + index, "li")
      }))
    });

    const diff = diffDomViews(start, captureDomView(tree), 2);

    expect(diff.added).toHaveLength(2);
    expect(diff.counts.added).toBe(5);
    expect(diff.truncated).toBe(true);
  });
});
