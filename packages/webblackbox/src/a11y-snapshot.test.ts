/* @vitest-environment jsdom */

import { DEFAULT_CAPTURE_POLICY, type CapturePolicy } from "@webblackbox/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { captureA11ySnapshot } from "./a11y-snapshot.js";

const TRIGGER = { kind: "action", rawType: "click" } as const;

function policy(
  overrides: {
    categories?: Partial<CapturePolicy["categories"]>;
    redaction?: Partial<CapturePolicy["redaction"]>;
  } = {}
): CapturePolicy {
  return {
    ...DEFAULT_CAPTURE_POLICY,
    categories: { ...DEFAULT_CAPTURE_POLICY.categories, ...overrides.categories },
    redaction: { ...DEFAULT_CAPTURE_POLICY.redaction, ...overrides.redaction }
  };
}

function tree(capturePolicy: CapturePolicy = policy()): string {
  return captureA11ySnapshot({ policy: capturePolicy, trigger: TRIGGER })?.tree ?? "";
}

afterEach(() => {
  document.body.innerHTML = "";
  document.title = "";
  vi.restoreAllMocks();
});

describe("captureA11ySnapshot", () => {
  it("writes roles, names, states and text of a form", () => {
    document.title = "Checkout";
    document.body.innerHTML = `
      <header><nav><a href="/">Home</a> <a href="/docs" aria-current="page">Docs</a></nav></header>
      <main>
        <h1>Checkout</h1>
        <form aria-label="Payment">
          <label for="email">Email</label>
          <input id="email" type="email" required aria-invalid="true" value="me@example.test">
          <label><input type="checkbox" checked> Remember me</label>
          <select aria-label="Country"><option>France</option><option selected>Spain</option></select>
          <button type="submit" disabled>Pay <span>now</span></button>
        </form>
        <div role="alert">Card declined</div>
        <p>Total: <strong>42 €</strong></p>
        <div><span>loose text</span></div>
      </main>`;

    const snapshot = captureA11ySnapshot({ policy: policy(), trigger: TRIGGER });

    expect(snapshot?.tree).toBe(
      [
        "- banner:",
        "  - navigation:",
        '    - link "Home"',
        '    - link "Docs" [current=page]',
        "- main:",
        '  - heading "Checkout" [level=1]',
        '  - form "Payment":',
        '    - text: "Email"',
        '    - textbox "Email" [required] [invalid]',
        '    - checkbox "Remember me" [checked]',
        '    - text: "Remember me"',
        '    - combobox "Country": "Spain"',
        '    - button "Pay now" [disabled]',
        '  - alert: "Card declined"',
        '  - paragraph: "Total: 42 €"',
        '  - text: "loose text"'
      ].join("\n")
    );
    expect(snapshot).toMatchObject({
      trigger: TRIGGER,
      title: "Checkout",
      scope: "viewport",
      truncated: false,
      omittedNodes: 0,
      masking: "masked"
    });
    expect(snapshot?.nodeCount).toBe(16);
  });

  it("records field values only where the inputs policy allows them", () => {
    document.body.innerHTML = `
      <input aria-label="Name" value="Ada">
      <input aria-label="Password" type="password" value="hunter2">`;

    // The default blocked selectors cover password fields.
    expect(tree()).toBe('- textbox "Name"\n- textbox [masked]');
    expect(tree(policy({ categories: { inputs: "allow" } }))).toBe(
      '- textbox "Name": "Ada"\n- textbox [masked]'
    );
    // Without that selector a password value is still never recorded while masking is on.
    expect(
      tree(policy({ categories: { inputs: "allow" }, redaction: { blockedSelectors: [] } }))
    ).toBe('- textbox "Name": "Ada"\n- textbox "Password"');
    // Masking off (Full capture): every value as typed.
    expect(
      tree(policy({ categories: { inputs: "allow" }, redaction: { contentRedaction: false } }))
    ).toBe('- textbox "Name": "Ada"\n- textbox "Password": "hunter2"');
  });

  it("masks blocked selectors: no name, text or children", () => {
    document.body.innerHTML = `
      <div class="secret"><button>Reveal 4111 1111 1111 1111</button></div>
      <section data-sensitive aria-label="Account"><p>IBAN DE00</p></section>
      <button>Visible</button>`;

    expect(tree()).toBe('- generic [masked]\n- region [masked]\n- button "Visible"');
    expect(
      tree(policy({ redaction: { contentRedaction: false, blockedSelectors: [] } }))
    ).toContain('- button "Reveal 4111 1111 1111 1111"');
  });

  it("fails closed to wireframe when a blocked selector is invalid", () => {
    document.body.innerHTML = `<h2>Secret plans</h2><button>Go</button>`;
    const snapshot = captureA11ySnapshot({
      policy: policy({ redaction: { blockedSelectors: ["[[invalid"] } }),
      trigger: TRIGGER
    });

    expect(snapshot?.masking).toBe("wireframe");
    expect(snapshot?.tree).toBe("- heading [level=2]\n- button");
  });

  it("keeps roles and states only under dom: wireframe", () => {
    document.title = "Inbox (3)";
    document.body.innerHTML = `<p>Hello Ada</p><button aria-pressed="true">Bold</button>`;
    const snapshot = captureA11ySnapshot({
      policy: policy({ categories: { dom: "wireframe" } }),
      trigger: TRIGGER
    });

    expect(snapshot?.tree).toBe("- paragraph\n- button [pressed]");
    expect(snapshot?.title).toBeUndefined();
  });

  it("applies the DOM value patterns and masks credentials in text", () => {
    document.body.innerHTML = `<p>Order ORD-12345 for jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl</p>`;
    const text = tree(
      policy({ redaction: { valuePatterns: [{ pattern: "ORD-\\d+", targets: ["dom"] }] } })
    );

    expect(text).not.toContain("ORD-12345");
    expect(text).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("skips hidden content, scripts and the recording indicator", () => {
    document.body.innerHTML = `
      <p hidden>hidden</p><p aria-hidden="true">aria hidden</p>
      <p style="display:none">display none</p><script>var x = 1</script>
      <div data-webblackbox-indicator="true">REC</div><p>shown</p>`;

    expect(tree()).toBe('- paragraph: "shown"');
  });

  it("leaves out what lies wholly outside the viewport", () => {
    document.body.innerHTML = `<p id="above">above the fold</p><p id="below">below the fold</p>`;
    const below = document.getElementById("below")!;
    vi.spyOn(below, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: window.innerHeight + 400, width: 300, height: 20 })
    );

    expect(tree()).toBe('- paragraph: "above the fold"');
  });

  it("reports expanded, selected, mixed and focus states", () => {
    document.body.innerHTML = `
      <details open><summary>More</summary><p>Body</p></details>
      <div role="tab" aria-selected="true">Tab A</div>
      <input type="checkbox" aria-label="All" id="all">
      <button id="focus">Focus me</button>`;
    (document.getElementById("all") as HTMLInputElement).indeterminate = true;
    document.getElementById("focus")!.focus();

    expect(tree()).toBe(
      [
        '- group "More":',
        '  - button "More" [expanded]',
        '  - paragraph: "Body"',
        '- tab "Tab A" [selected]',
        '- checkbox "All" [checked=mixed]',
        '- button "Focus me" [focused]'
      ].join("\n")
    );
  });

  it("stops at the time budget with an explicit cut", () => {
    document.body.innerHTML = Array.from({ length: 200 }, (_, index) => `<p>row ${index}</p>`).join(
      ""
    );
    let clock = 0;
    const snapshot = captureA11ySnapshot({
      policy: policy(),
      trigger: TRIGGER,
      now: () => (clock += 10),
      maxWalkMs: 40
    });

    expect(snapshot?.truncated).toBe(true);
    expect(snapshot?.omittedNodes).toBeGreaterThan(0);
    expect(snapshot?.tree).toMatch(/# cut: \d+ more nodes \(time budget, elements not examined\)$/);
  });

  it("bounds a huge page by the node budget", () => {
    document.body.innerHTML = Array.from(
      { length: 450 },
      (_, index) => `<div><a href="#r${index}">open ${index}</a><button>Act ${index}</button></div>`
    ).join("");
    const snapshot = captureA11ySnapshot({
      policy: policy(),
      trigger: TRIGGER,
      maxWalkMs: 60_000
    });

    expect(snapshot?.nodeCount).toBe(800);
    expect(snapshot?.omittedNodes).toBe(100);
    expect(snapshot?.tree.length).toBeLessThanOrEqual(24_064);
  });

  it("reports markup nested past the depth bound as cut instead of overflowing the stack", () => {
    let html = "<button>Deep</button>";

    // Just past the bound: jsdom is slow on deep markup; `e2e:a11y:heavy` checks 5k levels in Chrome.
    for (let index = 0; index < 300; index += 1) {
      html = `<div>${html}</div>`;
    }

    document.body.innerHTML = `<h1>Top</h1>${html}`;
    const snapshot = captureA11ySnapshot({ policy: policy(), trigger: TRIGGER, maxWalkMs: 60_000 });

    expect(snapshot?.tree).toMatch(
      /^- heading "Top" \[level=1\]\n# cut: 1 more nodes \(depth budget\)$/
    );
    expect(snapshot?.truncated).toBe(true);
  });

  it("inlines same-origin frames under their iframe node", () => {
    document.body.innerHTML = `<iframe title="Widget"></iframe>`;
    const frame = document.querySelector("iframe")!;
    frame.contentDocument!.body.innerHTML = `<button>Inside</button>`;

    const snapshot = captureA11ySnapshot({ policy: policy(), trigger: TRIGGER });

    expect(snapshot?.tree).toBe('- iframe "Widget":\n  - button "Inside"');
    expect(snapshot?.frames).toBe(1);
  });
});
