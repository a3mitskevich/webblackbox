import { describe, expect, it } from "vitest";

import { rewriteReplayResources } from "./dom-replay-resources.js";

const LOCAL: Record<string, string> = {
  "https://a.test/app.css": "blob:local/css",
  "https://a.test/logo.png": "blob:local/logo",
  "https://a.test/font.woff2": "blob:local/font"
};
const resolve = (url: string): string | null => LOCAL[url] ?? null;

describe("rewriteReplayResources", () => {
  it("points stylesheets, images and CSS urls at local copies and lists the rest", () => {
    const { events, unresolved } = rewriteReplayResources(
      [
        {
          type: 2,
          timestamp: 1,
          data: {
            node: {
              type: 0,
              childNodes: [
                {
                  type: 2,
                  tagName: "link",
                  attributes: { rel: "stylesheet", href: "https://a.test/app.css" }
                },
                { type: 2, tagName: "a", attributes: { href: "https://a.test/next" } },
                {
                  type: 2,
                  tagName: "img",
                  attributes: {
                    src: "https://a.test/logo.png",
                    srcset: "https://a.test/logo.png 1x, https://a.test/logo@2x.png 2x",
                    style: "background: url('https://a.test/missing.png')"
                  }
                },
                {
                  type: 2,
                  tagName: "style",
                  childNodes: [
                    { type: 3, textContent: "@font-face{src:url(https://a.test/font.woff2)}" }
                  ]
                }
              ]
            }
          }
        }
      ],
      resolve
    );
    type Node = {
      attributes: Record<string, string>;
      childNodes: Array<{ textContent?: string }>;
    };
    const root = (events[0]!.data as { node: { childNodes: Node[] } }).node;
    const [link, anchor, image, style] = root.childNodes;

    expect(link!.attributes.href).toBe("blob:local/css");
    expect(anchor!.attributes.href).toBe("https://a.test/next");
    expect(image!.attributes.src).toBe("blob:local/logo");
    expect(image!.attributes.srcset).toBe("blob:local/logo 1x, https://a.test/logo@2x.png 2x");
    expect(style!.childNodes[0]!.textContent).toBe("@font-face{src:url(blob:local/font)}");
    expect([...unresolved].sort()).toEqual([
      "https://a.test/logo@2x.png",
      "https://a.test/missing.png"
    ]);
  });

  it("rewrites added nodes and attribute changes and leaves other events as they are", () => {
    const click = { type: 3, timestamp: 3, data: { source: 2, type: 2, id: 1 } };
    const { events } = rewriteReplayResources(
      [
        {
          type: 3,
          timestamp: 2,
          data: {
            source: 0,
            adds: [
              {
                parentId: 1,
                node: { type: 2, tagName: "img", attributes: { src: "https://a.test/logo.png" } }
              }
            ],
            attributes: [{ id: 5, attributes: { src: "https://a.test/logo.png", title: "x" } }],
            texts: [],
            removes: []
          }
        },
        click
      ],
      resolve
    );
    const data = events[0]!.data as {
      adds: Array<{ node: { attributes: Record<string, string> } }>;
      attributes: Array<{ attributes: Record<string, string> }>;
    };

    expect(data.adds[0]!.node.attributes.src).toBe("blob:local/logo");
    expect(data.attributes[0]!.attributes).toEqual({ src: "blob:local/logo", title: "x" });
    expect(events[1]).toBe(click);
  });
});
