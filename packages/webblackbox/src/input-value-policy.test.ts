/* @vitest-environment jsdom */

import { DEFAULT_CAPTURE_POLICY, type CapturePolicy } from "@webblackbox/protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_CAPTURED_INPUT_VALUE_CHARS,
  notePasswordField,
  readCapturableInputValue,
  watchPasswordFieldReveals
} from "./input-value-policy.js";

function policy(
  inputs: CapturePolicy["categories"]["inputs"],
  redaction: Partial<CapturePolicy["redaction"]> = {}
): CapturePolicy {
  return {
    ...DEFAULT_CAPTURE_POLICY,
    categories: { ...DEFAULT_CAPTURE_POLICY.categories, inputs },
    redaction: { ...DEFAULT_CAPTURE_POLICY.redaction, ...redaction }
  };
}

function field(html: string): HTMLInputElement | HTMLTextAreaElement {
  document.body.innerHTML = html;
  const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>("[data-field]");

  if (!element) {
    throw new Error("missing field");
  }

  element.value = "typed value";
  return element;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("readCapturableInputValue", () => {
  it("keeps values only when inputs are allowed", () => {
    const input = field('<input data-field name="city" />');

    expect(readCapturableInputValue(input, policy("allow"))).toBe("typed value");
    expect(readCapturableInputValue(input, policy("length-only"))).toBeUndefined();
    expect(readCapturableInputValue(input, policy("none"))).toBeUndefined();
    expect(readCapturableInputValue(input, policy("masked"))).toBeUndefined();
  });

  it("never captures password-like fields", () => {
    expect(
      readCapturableInputValue(field('<input data-field type="password" />'), policy("allow"))
    ).toBeUndefined();
    expect(
      readCapturableInputValue(
        field('<input data-field autocomplete="one-time-code" />'),
        policy("allow", { unmaskSelectors: ["input"] })
      )
    ).toBeUndefined();
  });

  it("skips blocked selectors on the field or an ancestor unless unmasked", () => {
    const blocked = field('<div class="secret"><input data-field name="note" /></div>');

    expect(readCapturableInputValue(blocked, policy("allow"))).toBeUndefined();
    expect(
      readCapturableInputValue(blocked, policy("allow", { unmaskSelectors: ["[name='note']"] }))
    ).toBe("typed value");
    expect(
      readCapturableInputValue(field('<input data-field name="api_token" />'), policy("allow"))
    ).toBeUndefined();
  });

  it("keeps unmasked fields under the masked level", () => {
    const input = field('<textarea data-field class="order-notes"></textarea>');

    expect(
      readCapturableInputValue(input, policy("masked", { unmaskSelectors: [".order-notes"] }))
    ).toBe("typed value");
  });

  it("fails closed on invalid blocked selectors and caps long values", () => {
    const input = field('<input data-field name="q" />');
    input.value = "x".repeat(MAX_CAPTURED_INPUT_VALUE_CHARS + 50);

    expect(readCapturableInputValue(input, policy("allow"))).toHaveLength(
      MAX_CAPTURED_INPUT_VALUE_CHARS
    );
    expect(
      readCapturableInputValue(input, policy("allow", { blockedSelectors: ["[[bad"] }))
    ).toBeUndefined();
    expect(
      readCapturableInputValue(input, policy("masked", { unmaskSelectors: ["[[bad"] }))
    ).toBeUndefined();
  });

  it("never captures a password field after the page reveals it", () => {
    const input = field('<input data-field type="password" />');

    notePasswordField(input);
    input.setAttribute("type", "text");

    expect(
      readCapturableInputValue(input, policy("allow", { unmaskSelectors: ["input"] }))
    ).toBeUndefined();
  });

  it("never captures a password field revealed before anyone typed in it", async () => {
    const stop = watchPasswordFieldReveals(document);
    const input = field('<input data-field type="password" name="pin_code" />');

    input.setAttribute("type", "text");
    await Promise.resolve();
    stop();

    expect(readCapturableInputValue(input, policy("allow"))).toBeUndefined();
  });

  it("never captures password-named or payment card fields", () => {
    for (const html of [
      '<input data-field type="text" name="user_password" />',
      '<input data-field type="text" id="pwd" />',
      '<input data-field autocomplete="billing cc-number" />',
      '<input data-field autocomplete="cc-csc" />',
      '<input data-field autocomplete="cc-exp" />'
    ]) {
      expect(readCapturableInputValue(field(html), policy("allow"))).toBeUndefined();
    }
  });

  it("lets a nearer blocked selector win over an unmasked ancestor", () => {
    const sensitive = field('<form class="checkout"><input data-field data-sensitive /></form>');

    expect(
      readCapturableInputValue(sensitive, policy("allow", { unmaskSelectors: ["form.checkout"] }))
    ).toBeUndefined();

    const nested = field('<div data-sensitive><input data-field class="ok" /></div>');

    expect(readCapturableInputValue(nested, policy("allow", { unmaskSelectors: [".ok"] }))).toBe(
      "typed value"
    );
    expect(readCapturableInputValue(nested, policy("masked", { unmaskSelectors: ["div"] }))).toBe(
      "typed value"
    );
  });
});
