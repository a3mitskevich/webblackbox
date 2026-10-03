/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CAPTURE_POLICY, type CapturePolicy } from "@webblackbox/protocol";

import { buildReadableSelector, buildReadableTarget } from "./pointer-target.js";

const READABLE_POLICY: CapturePolicy = {
  ...DEFAULT_CAPTURE_POLICY,
  categories: { ...DEFAULT_CAPTURE_POLICY.categories, actions: "allow" }
};

function mount(html: string): void {
  document.body.innerHTML = html;
}

function element(selector: string): Element {
  const found = document.querySelector(selector);

  if (!found) {
    throw new Error(`missing ${selector}`);
  }

  return found;
}

describe("readable pointer targets", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("skips generated ids and escapes attribute values", () => {
    mount(`
      <div id="ember12345"><button name='say "hi"'>Hi</button></div>
      <button id="checkout">Pay</button>
    `);

    expect(buildReadableSelector(element("button[name]"))).toBe('button[name="say \\"hi\\""]');
    expect(buildReadableSelector(element("#checkout"))).toBe("#checkout");
    expect(buildReadableSelector(element("#ember12345"))).toBe("div");
  });

  it("reads labels of button-like inputs but never values of text fields", () => {
    mount(`
      <input id="submit" type="submit" value="Send order" />
      <input id="email" type="email" value="person@example.com" />
    `);

    expect(buildReadableTarget(element("#submit"), READABLE_POLICY)).toMatchObject({
      role: "button",
      text: "Send order"
    });

    const email = buildReadableTarget(element("#email"), READABLE_POLICY);
    expect(email).toMatchObject({ role: "textbox", css: "#email" });
    expect(JSON.stringify(email)).not.toContain("person@example.com");
  });

  it("clips long visible text", () => {
    mount(`<a href="/x">${"Very long link text ".repeat(5)}</a>`);

    const text = buildReadableTarget(element("a"), READABLE_POLICY)?.text ?? "";
    expect(text).toHaveLength(40);
    expect(text.endsWith("…")).toBe(true);
  });

  it("fails closed on invalid blocked selectors and honours unmask selectors", () => {
    mount(`<div class="card" data-sensitive><button id="open">Open</button></div>`);

    expect(
      buildReadableTarget(element("#open"), {
        ...READABLE_POLICY,
        redaction: { ...READABLE_POLICY.redaction, blockedSelectors: ["[[invalid"] }
      })
    ).toBeUndefined();
    expect(buildReadableTarget(element("#open"), READABLE_POLICY)).toBeUndefined();
    expect(
      buildReadableTarget(element("#open"), {
        ...READABLE_POLICY,
        redaction: { ...READABLE_POLICY.redaction, unmaskSelectors: ["#open"] }
      })
    ).toMatchObject({ text: "Open" });
  });

  it("keeps blocked, editable and script descendants out of a wrapper's label", () => {
    mount(`
      <a id="card" href="/card">
        Card <span data-sensitive>4111 1111 1111 1111</span>
        <script>window.secret = 1</script><span contenteditable="true">draft</span> ending
      </a>
    `);

    const readable = buildReadableTarget(element("#card"), READABLE_POLICY);
    expect(readable?.text).toBe("Card ending");
    expect(JSON.stringify(readable)).not.toMatch(/4111|secret|draft/);
  });

  it("reads only the start of a large subtree for the label", () => {
    mount(`<div id="big">${"<p>word word word</p>".repeat(5_000)}</div>`);

    const text = buildReadableTarget(element("#big"), READABLE_POLICY)?.text ?? "";
    expect(text).toHaveLength(40);
    expect(text.startsWith("word word word")).toBe(true);
  });

  it("returns nothing when the profile keeps actions as metadata", () => {
    mount(`<button id="go">Go</button>`);

    expect(buildReadableTarget(element("#go"), DEFAULT_CAPTURE_POLICY)).toBeUndefined();
  });
});
