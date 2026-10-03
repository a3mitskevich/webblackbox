/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";

import { notePasswordField } from "./input-value-policy.js";
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

  it("never keeps the value of a password the page revealed, even with inputs allowed", () => {
    document.body.innerHTML = '<input id="pw1" type="password" value="REVEALEDPW">';
    const field = document.getElementById("pw1") as HTMLInputElement;

    notePasswordField(field);
    field.setAttribute("type", "text");

    expect(serializeRawDom(document, { ...OPTIONS, keepInputValues: true })?.html).not.toContain(
      "REVEALEDPW"
    );
  });

  it("removes secrets carried by attributes, comments, templates and inline documents", () => {
    document.head.innerHTML = `
      <meta name="csrf-token" content="CSRF-SECRET">
      <meta name="viewport" content="width=device-width">`;
    document.body.innerHTML = `
      <a href="https://app.test/reset?token=RESET-SECRET#frag">reset</a>
      <form action="/login?code=OAUTH-SECRET"><button name="otp" value="OTP-SECRET">go</button></form>
      <img src="/img.png?sig=IMG-SECRET" srcset="/a.png?k=SRCSET-SECRET 2x">
      <div data-api-key="DATA-SECRET" data-color="blue" onclick="leak('HANDLER-SECRET')">box</div>
      <!-- COMMENT-SECRET -->
      <iframe srcdoc="&lt;p class='secret'&gt;SRCDOC-SECRET&lt;/p&gt;"></iframe>
      <noscript>NOSCRIPT-SECRET</noscript>
      <template><div class="secret">TEMPLATE-SECRET</div><input type="hidden" value="TPL-HIDDEN"></template>`;

    const html = serializeRawDom(document, OPTIONS)?.html ?? "";

    for (const secret of [
      "CSRF-SECRET",
      "RESET-SECRET",
      "OAUTH-SECRET",
      "OTP-SECRET",
      "IMG-SECRET",
      "SRCSET-SECRET",
      "DATA-SECRET",
      "HANDLER-SECRET",
      "COMMENT-SECRET",
      "SRCDOC-SECRET",
      "NOSCRIPT-SECRET",
      "TEMPLATE-SECRET",
      "TPL-HIDDEN"
    ]) {
      expect(html, secret).not.toContain(secret);
    }

    expect(html).toContain('content="width=device-width"');
    expect(html).toContain('data-color="blue"');
    expect(html).toContain("https://app.test/reset");
    document.head.innerHTML = "";
  });

  it("masks blocked elements even when the page forges the masked marker", () => {
    document.body.innerHTML =
      '<div class="secret" data-webblackbox-masked="x">card 4111111111111111</div>';

    expect(serializeRawDom(document, OPTIONS)?.html).not.toContain("4111111111111111");
  });

  it("strips queries from namespaced and CSS URLs, keeping ordinary attributes", () => {
    document.body.innerHTML = `
      <svg><a xlink:href="https://h.test/p?token=XLINK-SECRET"><text>x</text></a></svg>
      <div class="secret" style="background:url(/a.png?token=MASKED-STYLE-SECRET)">x</div>
      <div style="background:url('/b.png?sig=STYLE-SECRET')" one="keep-one" data-hotpath="keep-hot">y</div>
      <style>.hero { background: url("/c.png?X-Amz-Signature=CSS-SECRET"); }</style>
      <textarea name="otp">TEXTAREA-OTP</textarea>`;

    const html = serializeRawDom(document, { ...OPTIONS, keepInputValues: true })?.html ?? "";

    for (const secret of [
      "XLINK-SECRET",
      "MASKED-STYLE-SECRET",
      "STYLE-SECRET",
      "CSS-SECRET",
      "TEXTAREA-OTP"
    ]) {
      expect(html, secret).not.toContain(secret);
    }

    expect(html).toContain('one="keep-one"');
    expect(html).toContain('data-hotpath="keep-hot"');
    expect(html).toContain("/b.png");
  });

  it("strips CSS URL queries in linear time and catches every CSS URL form", () => {
    document.body.innerHTML = `
      <style>@import "/x.css?token=IMPORT-SECRET"; .a { background: image-set("/i.png?token=SET-SECRET" 1x); }</style>
      <div style="background:url(/a(1).png?token=PAREN-SECRET)">a</div>
      <svg><rect fill="url(https://h.test/p?token=FILL-SECRET#g)"></rect></svg>
      <div data-csrftoken="RUN-TOGETHER-SECRET" data-sessionid="SESSION-SECRET">b</div>`;

    const html = serializeRawDom(document, OPTIONS)?.html ?? "";

    for (const secret of [
      "IMPORT-SECRET",
      "SET-SECRET",
      "PAREN-SECRET",
      "FILL-SECRET",
      "RUN-TOGETHER-SECRET",
      "SESSION-SECRET"
    ]) {
      expect(html, secret).not.toContain(secret);
    }

    for (const css of [`url(${" ".repeat(200_000)}`, "url(".repeat(100_000)]) {
      document.body.innerHTML = "";
      const style = document.createElement("style");
      style.textContent = css;
      document.body.append(style);
      const started = performance.now();

      serializeRawDom(document, OPTIONS);

      expect(performance.now() - started).toBeLessThan(1_000);
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
