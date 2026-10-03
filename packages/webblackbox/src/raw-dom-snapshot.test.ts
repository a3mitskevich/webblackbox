/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";

import { RAW_DOM_SNAPSHOT_MAX_CHARS, serializeRawDom } from "./raw-dom-snapshot.js";

const OPTIONS = { blockedSelectors: [".secret", "[data-sensitive]"], keepInputValues: false };

afterEach(() => {
  document.body.innerHTML = "";
});

describe("serializeRawDom", () => {
  it("records the visible page and masks blocked elements, scripts and the indicator", () => {
    document.body.innerHTML = `
      <h1>Order 42 shipped</h1>
      <p class="secret">card 4111 1111 1111 1111</p>
      <div data-sensitive data-id="7"><span>ssn 123-45-6789</span></div>
      <script>window.token = "abc123"</script>
      <div data-webblackbox-indicator="true">REC</div>`;

    const snapshot = serializeRawDom(document, OPTIONS);

    expect(snapshot?.html).toContain("Order 42 shipped");
    expect(snapshot?.html).not.toContain("4111");
    expect(snapshot?.html).not.toContain("123-45-6789");
    expect(snapshot?.html).not.toContain('data-id="7"');
    expect(snapshot?.html).toContain('class="secret" data-webblackbox-masked="true">[REDACTED]');
    expect(snapshot?.html).not.toContain("abc123");
    expect(snapshot?.html).not.toContain("REC");
    expect(snapshot?.truncated).toBe(false);
    expect(document.body.innerHTML).toContain("4111");
  });

  it("drops field values unless inputs are allowed, and never keeps password or hidden values", () => {
    document.body.innerHTML = `
      <input name="city" value="Berlin">
      <input type="password" value="hunter2">
      <input type="text" name="user_password" value="revealed">
      <input type="hidden" name="csrf" value="tok-1">
      <textarea>notes</textarea>`;

    const strict = serializeRawDom(document, OPTIONS)?.html ?? "";
    const allowed = serializeRawDom(document, { ...OPTIONS, keepInputValues: true })?.html ?? "";

    expect(strict).not.toContain("Berlin");
    expect(strict).not.toContain("notes");
    expect(allowed).toContain("Berlin");
    expect(allowed).toContain("notes");

    for (const html of [strict, allowed]) {
      expect(html).not.toContain("hunter2");
      expect(html).not.toContain("revealed");
      expect(html).not.toContain("tok-1");
    }
  });

  it("fails closed on an invalid blocked selector and caps the size", () => {
    document.body.innerHTML = `<p>${"x".repeat(RAW_DOM_SNAPSHOT_MAX_CHARS)}</p>`;

    expect(serializeRawDom(document, { ...OPTIONS, blockedSelectors: ["[[bad"] })).toBeNull();

    const snapshot = serializeRawDom(document, OPTIONS);

    expect(snapshot?.truncated).toBe(true);
    expect(snapshot?.html).toHaveLength(RAW_DOM_SNAPSHOT_MAX_CHARS);
    expect(snapshot?.htmlLength).toBeGreaterThan(RAW_DOM_SNAPSHOT_MAX_CHARS);
  });
});
