import { describe, expect, it } from "vitest";

import {
  A11Y_SNAPSHOT_LIMITS,
  formatA11yNodeLine,
  formatA11yTree,
  parseA11yTree,
  parseA11yTreeLine,
  type A11yTreeNode,
  type DomA11ySnapshotData
} from "./a11y.js";
import { domA11ySnapshotDataSchema } from "./a11y-schemas.js";
import { validateEventData } from "./schemas.js";

const FORM: A11yTreeNode[] = [
  {
    role: "main",
    children: [
      { role: "heading", name: "Checkout", states: ["level=1"] },
      { role: "textbox", name: "Email", states: ["required", "invalid"], value: "a@b" },
      { role: "button", name: 'Pay "now"', states: ["disabled"] },
      { role: "alert", value: "Card declined" }
    ]
  }
];

function snapshot(overrides: Partial<DomA11ySnapshotData> = {}): DomA11ySnapshotData {
  return {
    trigger: { kind: "action", rawType: "click", eventId: "E-1" },
    url: "https://shop.test/checkout",
    title: "Checkout",
    viewport: { w: 1280, h: 720, scrollX: 0, scrollY: 120 },
    scope: "viewport",
    tree: formatA11yTree(FORM).tree,
    nodeCount: 5,
    omittedNodes: 0,
    truncated: false,
    masking: "masked",
    durationMs: 3.5,
    ...overrides
  };
}

describe("a11y tree text", () => {
  it("writes one node per line with names, states, values and indented children", () => {
    expect(formatA11yTree(FORM).tree).toBe(
      [
        "- main:",
        '  - heading "Checkout" [level=1]',
        '  - textbox "Email" [required] [invalid]: "a@b"',
        '  - button "Pay \\"now\\"" [disabled]',
        '  - alert: "Card declined"'
      ].join("\n")
    );
  });

  it("reads every line back", () => {
    const parsed = parseA11yTree(formatA11yTree(FORM).tree);

    expect(parsed).toEqual([
      { depth: 0, role: "main", states: [] },
      { depth: 1, role: "heading", name: "Checkout", states: ["level=1"] },
      { depth: 1, role: "textbox", name: "Email", states: ["required", "invalid"], value: "a@b" },
      { depth: 1, role: "button", name: 'Pay "now"', states: ["disabled"] },
      { depth: 1, role: "alert", states: [], value: "Card declined" }
    ]);
  });

  it("keeps brackets and colons inside quoted names", () => {
    const line = formatA11yNodeLine({ role: "link", name: "a [b]: c", states: ["focused"] });

    expect(parseA11yTreeLine(line)).toEqual({
      depth: 0,
      role: "link",
      name: "a [b]: c",
      states: ["focused"]
    });
  });

  it("ignores meta lines", () => {
    expect(parseA11yTreeLine("# cut: 3 more nodes (size budget)")).toBeNull();
  });

  it("cuts at the node budget with an explicit marker counting the missing subtree", () => {
    const formatted = formatA11yTree(FORM, { maxNodes: 2 });

    expect(formatted.nodeCount).toBe(2);
    expect(formatted.omittedNodes).toBe(3);
    expect(formatted.truncated).toBe(true);
    expect(formatted.tree.split("\n").at(-1)).toBe("# cut: 3 more nodes (node budget)");
  });

  it("cuts at the size budget", () => {
    const wide: A11yTreeNode[] = Array.from({ length: 50 }, (_, index) => ({
      role: "listitem",
      value: `item ${index} `.repeat(10)
    }));
    const formatted = formatA11yTree(wide, { maxChars: 1_000 });

    expect(formatted.tree.length).toBeLessThanOrEqual(1_000 + 64);
    expect(formatted.omittedNodes).toBe(50 - formatted.nodeCount);
    expect(formatted.tree).toMatch(/# cut: \d+ more nodes \(size budget\)$/);
  });

  it("reports nodes the walk skipped before formatting", () => {
    const formatted = formatA11yTree(FORM, { omittedBefore: 7, cutReason: "time budget" });

    expect(formatted.omittedNodes).toBe(7);
    expect(formatted.tree.endsWith("# cut: 7 more nodes (time budget)")).toBe(true);
  });

  it("stays within the default budget for huge pages", () => {
    const huge: A11yTreeNode[] = Array.from({ length: 5_000 }, (_, index) => ({
      role: "button",
      name: `Act ${index}`
    }));
    const formatted = formatA11yTree(huge);

    expect(formatted.nodeCount).toBe(A11Y_SNAPSHOT_LIMITS.maxNodes);
    expect(formatted.tree.length).toBeLessThanOrEqual(A11Y_SNAPSHOT_LIMITS.maxTreeChars + 64);
  });
});

describe("dom.a11y.snapshot schema", () => {
  it("accepts a snapshot", () => {
    expect(domA11ySnapshotDataSchema.safeParse(snapshot()).success).toBe(true);
    expect(validateEventData("dom.a11y.snapshot", snapshot()).success).toBe(true);
  });

  it("rejects unknown fields, triggers and oversized trees", () => {
    expect(validateEventData("dom.a11y.snapshot", { ...snapshot(), extra: 1 }).success).toBe(false);
    expect(
      validateEventData("dom.a11y.snapshot", snapshot({ trigger: { kind: "hover" as "action" } }))
        .success
    ).toBe(false);
    expect(
      validateEventData(
        "dom.a11y.snapshot",
        snapshot({ tree: "x".repeat(A11Y_SNAPSHOT_LIMITS.maxTreeChars + 1_000) })
      ).success
    ).toBe(false);
  });
});
