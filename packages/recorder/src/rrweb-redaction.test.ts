import { describe, expect, it } from "vitest";

import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  RRWEB_EVENT_SCHEMA,
  RRWEB_RAW_TYPE,
  type RecorderConfig,
  type RrwebEventBatchPayload
} from "@webblackbox/protocol";

import { WebBlackboxRecorder } from "./recorder.js";
import { redactRrwebEventBatch } from "./rrweb-redaction.js";

const CONFIG: RecorderConfig = {
  ...DEFAULT_RECORDER_CONFIG,
  redaction: { ...DEFAULT_RECORDER_CONFIG.redaction, builtInHeuristics: false },
  capturePolicy: {
    ...DEFAULT_CAPTURE_POLICY,
    categories: { ...DEFAULT_CAPTURE_POLICY.categories, dom: "allow" }
  }
};

const RULES = { ...CONFIG.redaction, redactQueryParams: ["session"] };

function batch(events: RrwebEventBatchPayload["events"]): RrwebEventBatchPayload {
  return { schema: RRWEB_EVENT_SCHEMA, events };
}

const FULL_SNAPSHOT = {
  type: 2,
  timestamp: 1_000,
  data: {
    node: {
      type: 0,
      id: 1,
      childNodes: [
        {
          type: 2,
          id: 2,
          tagName: "a",
          attributes: { href: "https://a.test/page?session=abc&x=1", class: "otp-link" },
          childNodes: [{ type: 3, id: 3, textContent: "Enter your OTP token" }]
        },
        {
          type: 2,
          id: 4,
          tagName: "img",
          attributes: {
            src: "https://cdn.a.test/i.png?session=s1",
            srcset: "https://cdn.a.test/i.png?session=s1 1x, https://cdn.a.test/i2.png 2x"
          },
          childNodes: []
        },
        {
          type: 2,
          id: 5,
          tagName: "img",
          attributes: { src: "data:image/png;base64,AAAA" },
          childNodes: []
        }
      ]
    },
    initialOffset: { left: 0, top: 0 }
  }
};

describe("redactRrwebEventBatch", () => {
  it("records URL attributes under the URL rules and keeps the node tree intact", () => {
    const redacted = redactRrwebEventBatch(batch([FULL_SNAPSHOT]), RULES);
    const root = (redacted.events[0]!.data as { node: { childNodes: unknown[] } }).node;
    const [link, image, inlineImage] = root.childNodes as Array<{
      attributes: Record<string, string>;
      childNodes: Array<{ textContent?: string }>;
    }>;

    expect(link!.attributes.href).toBe("https://a.test/page?session=[REDACTED]&x=1");
    expect(link!.attributes.class).toBe("otp-link");
    expect(link!.childNodes[0]!.textContent).toBe("Enter your OTP token");
    expect(image!.attributes.src).toBe("https://cdn.a.test/i.png?session=[REDACTED]");
    expect(image!.attributes.srcset).toBe(
      "https://cdn.a.test/i.png?session=[REDACTED] 1x, https://cdn.a.test/i2.png 2x"
    );
    expect(inlineImage!.attributes.src).toBe("data:image/png;base64,AAAA");
  });

  it("keeps commas inside srcset URLs", () => {
    const redacted = redactRrwebEventBatch(
      batch([
        {
          type: 3,
          timestamp: 1,
          data: {
            source: 0,
            texts: [],
            removes: [],
            adds: [],
            attributes: [
              {
                id: 4,
                attributes: {
                  srcset:
                    "https://img.test/w_100,h_100/a.jpg?session=s 1x,https://img.test/b.jpg,  " +
                    "https://img.test/c.jpg 3x"
                }
              }
            ]
          }
        }
      ]),
      RULES
    );
    const change = (redacted.events[0]!.data as { attributes: Array<{ attributes: object }> })
      .attributes[0]!.attributes as Record<string, string>;

    expect(change.srcset).toBe(
      "https://img.test/w_100,h_100/a.jpg?session=[REDACTED] 1x, https://img.test/b.jpg, " +
        "https://img.test/c.jpg 3x"
    );
  });

  it("records URLs in meta events, added nodes and attribute mutations", () => {
    const redacted = redactRrwebEventBatch(
      batch([
        { type: 4, timestamp: 1, data: { href: "https://a.test/?session=1", width: 1, height: 1 } },
        {
          type: 3,
          timestamp: 2,
          data: {
            source: 0,
            texts: [],
            removes: [],
            adds: [
              {
                parentId: 1,
                nextId: null,
                node: { type: 2, id: 9, tagName: "a", attributes: { href: "/x?session=2" } }
              }
            ],
            attributes: [{ id: 2, attributes: { href: "/y?session=3", style: { color: "red" } } }]
          }
        },
        { type: 3, timestamp: 3, data: { source: 2, type: 2, id: 2, x: 1, y: 1 } }
      ]),
      RULES
    );
    const [meta, mutation, click] = redacted.events;
    const mutationData = mutation!.data as {
      adds: Array<{ node: { attributes: Record<string, string> } }>;
      attributes: Array<{ attributes: Record<string, unknown> }>;
    };

    expect((meta!.data as { href: string }).href).toBe("https://a.test/?session=[REDACTED]");
    expect(mutationData.adds[0]!.node.attributes.href).toBe("/x?session=[REDACTED]");
    expect(mutationData.attributes[0]!.attributes.href).toBe("/y?session=[REDACTED]");
    expect(mutationData.attributes[0]!.attributes.style).toEqual({ color: "red" });
    expect(click).toEqual({
      type: 3,
      timestamp: 3,
      data: { source: 2, type: 2, id: 2, x: 1, y: 1 }
    });
  });
});

describe("recorder ingest of rrweb batches", () => {
  it("maps rrwebRecord to dom.rrweb.event without the generic key walker", () => {
    const recorder = new WebBlackboxRecorder(CONFIG);
    const result = recorder.ingest({
      source: "content",
      rawType: RRWEB_RAW_TYPE,
      sid: "S-rrweb2",
      tabId: 1,
      t: 1_000,
      mono: 10,
      payload: batch([FULL_SNAPSHOT])
    });
    const data = result.event?.data as RrwebEventBatchPayload;
    const root = data.events[0]!.data as { node: { childNodes: Array<{ childNodes: unknown[] }> } };

    expect(result.event?.type).toBe("dom.rrweb.event");
    expect(data.schema).toBe(RRWEB_EVENT_SCHEMA);
    // The generic walker would have masked this text node whole (it contains "otp"/"token").
    expect(root.node.childNodes[0]!.childNodes[0]).toEqual({
      type: 3,
      id: 3,
      textContent: "Enter your OTP token"
    });
  });

  it("drops rrweb batches when the profile records no DOM", () => {
    const recorder = new WebBlackboxRecorder({
      ...CONFIG,
      capturePolicy: {
        ...DEFAULT_CAPTURE_POLICY,
        categories: { ...DEFAULT_CAPTURE_POLICY.categories, dom: "off" }
      }
    });
    const result = recorder.ingest({
      source: "content",
      rawType: RRWEB_RAW_TYPE,
      sid: "S-rrweb2",
      tabId: 1,
      t: 1_000,
      mono: 10,
      payload: batch([FULL_SNAPSHOT])
    });

    expect(result.event?.type).not.toBe("dom.rrweb.event");
  });
});
