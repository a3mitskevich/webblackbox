import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import type { WebBlackboxEvent } from "@webblackbox/protocol";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__", "rrweb");

/**
 * Real recordings (extension build of task 60, Chrome, `apps/extension/scripts/rrweb-measure.mjs`):
 * the `dom.rrweb.event`, `user.click` and input events of the archive.
 * - `realistic-site-lite`: the realistic site, Lite + Default, 40 s, a click every 3 s;
 * - `heavy-spa-600-lite`: the heavy SPA with 600 rows, Lite + Default, 30 s; route changes pause
 *   rrweb (mutation-size) and it resumes with fresh full snapshots.
 */
export function loadRrwebFixture(
  name: "realistic-site-lite" | "heavy-spa-600-lite"
): WebBlackboxEvent[] {
  const bytes = readFileSync(resolve(FIXTURES, `${name}.json.gz`));
  return JSON.parse(gunzipSync(bytes).toString("utf8")) as WebBlackboxEvent[];
}

let nextEventId = 1;

/** A `dom.rrweb.event` batch for synthetic tests. */
export function rrwebBatch(
  mono: number,
  events: Array<{ type: number; timestamp: number; data: unknown }>,
  recorder?: Record<string, unknown>
): WebBlackboxEvent {
  return {
    v: 1,
    sid: "S-test",
    tab: 1,
    t: mono,
    mono,
    type: "dom.rrweb.event",
    id: `E-${String(nextEventId++).padStart(6, "0")}`,
    data: { schema: "rrweb/v2", events, ...(recorder ? { recorder } : {}) }
  };
}

type Node = Record<string, unknown>;

export const el = (
  id: number,
  tagName: string,
  attributes: Record<string, unknown> = {},
  childNodes: Node[] = []
): Node => ({
  type: 2,
  id,
  tagName,
  attributes,
  childNodes
});

export const text = (id: number, textContent: string): Node => ({ type: 3, id, textContent });

/** `<!doctype html><html><head><title>T</title></head><body>…body</body></html>`, ids from 1. */
export function documentNode(body: Node[], title = "Test page"): Node {
  return {
    type: 0,
    id: 1,
    childNodes: [
      { type: 1, id: 2, name: "html", publicId: "", systemId: "" },
      el(3, "html", {}, [
        el(4, "head", {}, [el(5, "title", {}, [text(6, title)])]),
        el(7, "body", {}, body)
      ])
    ]
  };
}

export const meta = (timestamp: number, href = "https://app.test/orders") => ({
  type: 4,
  timestamp,
  data: { href, width: 1280, height: 720 }
});

export const fullSnapshot = (timestamp: number, node: Node) => ({
  type: 2,
  timestamp,
  data: { node, initialOffset: { top: 0, left: 0 } }
});

export const mutation = (timestamp: number, data: Record<string, unknown>) => ({
  type: 3,
  timestamp,
  data: { source: 0, texts: [], attributes: [], removes: [], adds: [], ...data }
});

export const click = (timestamp: number, id: number, x = 10, y = 10) => ({
  type: 3,
  timestamp,
  data: { source: 2, type: 2, id, x, y }
});

export const input = (timestamp: number, id: number, value: string) => ({
  type: 3,
  timestamp,
  data: { source: 5, id, text: value, isChecked: false }
});
