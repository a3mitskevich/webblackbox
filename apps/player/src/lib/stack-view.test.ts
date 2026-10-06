/* @vitest-environment jsdom */
import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it, vi } from "vitest";

import { createPlayerI18n } from "./i18n.js";
import {
  createStackViewController,
  describeOriginalFrame,
  renderStackFramesHtml
} from "./stack-view.js";

const messages = createPlayerI18n("en").messages.stackView;
const SCRIPT = "https://app.test/assets/app.min.js";
// Generated 1:1 → src/cart.ts 3:5, name "boom".
const MAP = JSON.stringify({
  version: 3,
  sources: ["src/cart.ts"],
  sourcesContent: ["// cart\nconst x = 1;\nfunction boom() {}\n"],
  names: ["boom"],
  mappings: "AAEIA"
});

describe("renderStackFramesHtml", () => {
  it("escapes archive strings and switches between original and raw frames", () => {
    const frames = [
      {
        frame: { url: SCRIPT, line: 1, column: 1, raw: "at <img onerror=x> (a.js:1:1)" },
        status: "mapped" as const,
        original: { source: "src/<b>.ts", line: 3, column: 5, functionName: "boom" },
        snippet: { startLine: 3, highlightLine: 3, lines: ["<script>"] },
        mapSource: "archive"
      },
      {
        frame: { url: "https://x.test/v.js", line: 1, column: 2, raw: "at v (v.js:1:2)" },
        status: "map-error" as const,
        error: "HTTP 404"
      }
    ];
    const original = renderStackFramesHtml(frames, "original", messages);
    const raw = renderStackFramesHtml(frames, "raw", messages);

    expect(original).toContain("src/&lt;b&gt;.ts:3:5");
    expect(original).toContain("&lt;script&gt;");
    expect(original).toContain("source map error: HTTP 404");
    expect(original).not.toContain("<img");
    expect(raw).not.toContain("src/&lt;b&gt;.ts");
    expect(raw).toContain("at v (v.js:1:2)");
    expect(describeOriginalFrame(frames[0])).toBe("src/<b>.ts:3:5");
    expect(describeOriginalFrame(frames[1])).toBeNull();
  });
});

describe("createStackViewController", () => {
  it("shows original frames from maps embedded in the archive and toggles to raw", async () => {
    const root = document.createElement("section");
    const onResolved = vi.fn();
    const controller = createStackViewController({ root, messages, onResolved });
    const scriptEvent = event("sys.script", {
      script: SCRIPT,
      sourceMap: `${SCRIPT}.map`,
      origin: "cdp",
      map: { contentHash: "h1", size: MAP.length }
    });
    const errorEvent = event("error.exception", {
      message: "boom",
      stack: `Error: boom\n    at b (${SCRIPT}?v=2:1:1)`
    });

    controller.setArchive({
      query: ({ types }) => [scriptEvent].filter((entry) => types.includes(entry.type)),
      getBlob: async () => ({ mime: "application/json", bytes: new TextEncoder().encode(MAP) })
    });
    controller.render(errorEvent);

    expect(root.hidden).toBe(false);
    await vi.waitFor(() => expect(root.textContent).toContain("src/cart.ts:3:5"));
    expect(root.textContent).toContain("function boom() {}");
    expect(controller.describeTopFrame(errorEvent)).toBe("assets/src/cart.ts:3:5");

    root.querySelector<HTMLButtonElement>('[data-stack-action="mode"]')?.click();
    expect(root.textContent).not.toContain("src/cart.ts:3:5");
    expect(root.textContent).toContain(`${SCRIPT}?v=2:1:1`);

    controller.render(event("console.entry", { level: "log", text: "no stack" }));
    expect(root.hidden).toBe(true);
  });

  it("prefetches console events in the background and reports missing maps", async () => {
    const root = document.createElement("section");
    const onResolved = vi.fn();
    const controller = createStackViewController({ root, messages, onResolved });
    const errorEvent = event("error.exception", {
      stack: "Error: x\n    at f (https://other.test/f.js:1:1)"
    });

    controller.setArchive({ query: () => [], getBlob: async () => null });
    controller.prefetch(errorEvent);

    await vi.waitFor(() => expect(onResolved).toHaveBeenCalled());
    expect(controller.describeTopFrame(errorEvent)).toBeNull();

    controller.render(errorEvent);
    await vi.waitFor(() => expect(root.textContent).toContain("no source map"));
  });
});

function event(type: WebBlackboxEvent["type"], data: unknown): WebBlackboxEvent {
  return { v: 1, sid: "S", tab: 1, t: 1, mono: 1, type, id: `E-${type}`, data };
}
