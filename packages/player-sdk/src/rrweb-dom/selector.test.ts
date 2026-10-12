import { describe, expect, it } from "vitest";

import { documentNode, el, text } from "../test-support/rrweb-fixtures.js";
import { parseSelector, querySelectorAll, UnsupportedSelectorError } from "./selector.js";
import { DomTree } from "./tree.js";

const tree = DomTree.fromSnapshot(
  documentNode([
    el(10, "main", { id: "app" }, [
      el(11, "ul", { class: "list primary" }, [
        el(12, "li", { "data-state": "Open", lang: "en-US" }, [text(13, "a")]),
        el(14, "li", { "data-state": "closed" }, [
          el(15, "a", { href: "https://x.test/a?b=1", class: "link" }, [text(16, "b")])
        ])
      ]),
      el(17, "button", { id: "pay", class: "btn primary" })
    ])
  ])
);

const select = (selector: string, limit = 50) => querySelectorAll(tree, 1, selector, limit);

describe("querySelectorAll", () => {
  it("matches type, id, class and the universal selector", () => {
    expect(select("li")).toEqual([12, 14]);
    expect(select("#pay")).toEqual([17]);
    expect(select(".primary")).toEqual([11, 17]);
    expect(select("button.btn.primary#pay")).toEqual([17]);
    expect(select("main > *")).toEqual([11, 17]);
  });

  it("matches attribute selectors", () => {
    expect(select("[data-state]")).toEqual([12, 14]);
    expect(select('[data-state="closed"]')).toEqual([14]);
    expect(select("[data-state=open i]")).toEqual([12]);
    expect(select("[class~=list]")).toEqual([11]);
    expect(select('[href^="https://x.test"]')).toEqual([15]);
    expect(select('[href$="b=1"]')).toEqual([15]);
    expect(select("[href*=test]")).toEqual([15]);
    expect(select("[lang|=en]")).toEqual([12]);
    expect(select("[href^='']")).toEqual([]);
  });

  it("matches descendant and child combinators and selector lists", () => {
    expect(select("main a")).toEqual([15]);
    expect(select("main > a")).toEqual([]);
    expect(select("ul > li > a.link")).toEqual([15]);
    expect(select("#app li, #pay")).toEqual([12, 14, 17]);
    expect(select("li", 1)).toEqual([12]);
  });

  it("rejects what it cannot match instead of guessing", () => {
    for (const selector of ["li:first-child", "a + b", "[unclosed", "", "a,,b", "li 'x'", "#"]) {
      expect(() => parseSelector(selector), selector).toThrow(UnsupportedSelectorError);
    }

    expect(() => parseSelector("a".repeat(2_000))).toThrow(UnsupportedSelectorError);
  });
});
