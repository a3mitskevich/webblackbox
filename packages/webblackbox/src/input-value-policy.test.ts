/* @vitest-environment jsdom */

import { DEFAULT_CAPTURE_POLICY, type CapturePolicy } from "@webblackbox/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

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

  it("never captures a password field revealed before anyone typed in it", () => {
    const stop = watchPasswordFieldReveals(document);
    const input = field('<input data-field type="password" name="pin_code" />');

    input.setAttribute("type", "text");
    // Read in the same task as the reveal, before the observer callback runs.
    const value = readCapturableInputValue(input, policy("allow"));
    stop();

    expect(value).toBeUndefined();
  });

  it("shares revealed password fields between separately loaded bundles", async () => {
    vi.resetModules();
    const contentScript = await import("./input-value-policy.js");
    vi.resetModules();
    const captureAgent = await import("./input-value-policy.js");
    const stop = contentScript.watchPasswordFieldReveals(document);
    const input = field('<input data-field type="password" name="pin" />');

    input.setAttribute("type", "text");
    await Promise.resolve();
    stop();

    expect(captureAgent).not.toBe(contentScript);
    expect(captureAgent.readCapturableInputValue(input, policy("allow"))).toBeUndefined();
  });

  it("ignores a fake registry planted by the page", async () => {
    const key = Symbol.for("webblackbox.passwordFieldRegistry");
    const holder = globalThis as Record<symbol, unknown>;
    const original = Object.getOwnPropertyDescriptor(holder, key);

    Reflect.deleteProperty(holder, key);
    holder[key] = { fields: { has: () => false, add: () => undefined }, watchers: new Set() };

    try {
      vi.resetModules();
      const policyModule = await import("./input-value-policy.js");
      const stop = policyModule.watchPasswordFieldReveals(document);
      const revealed = field('<input data-field type="password" name="pin" />');

      revealed.setAttribute("type", "text");
      await Promise.resolve();
      stop();

      expect(policyModule.readCapturableInputValue(revealed, policy("allow"))).toBeUndefined();
      expect(
        policyModule.readCapturableInputValue(
          field('<input data-field type="password" />'),
          policy("allow")
        )
      ).toBeUndefined();
    } finally {
      Reflect.deleteProperty(holder, key);

      if (original) {
        Object.defineProperty(holder, key, original);
      }
    }
  });

  it("shares one watcher per root across repeated loads", () => {
    const observeSpy = vi.spyOn(MutationObserver.prototype, "observe");
    const stops = [
      watchPasswordFieldReveals(document),
      watchPasswordFieldReveals(document),
      watchPasswordFieldReveals(document)
    ];

    expect(observeSpy.mock.calls.length).toBeLessThanOrEqual(1);
    stops.forEach((stop) => stop());
    observeSpy.mockRestore();
  });

  it("keeps fields whose names only contain the letters of a one-time-code word", () => {
    for (const html of [
      '<input data-field name="footprint" />',
      '<input data-field id="shotput" />',
      '<input data-field name="donation_onetime_amount" />',
      '<input data-field id="field-a12fa3" />',
      '<input data-field id="field-9c2fa1" />',
      '<input data-field id="a7f2fa3b" />',
      '<input data-field name="author" />'
    ]) {
      expect(readCapturableInputValue(field(html), policy("allow")), html).toBe("typed value");
    }
  });

  it("never captures password-named or payment card fields", () => {
    for (const html of [
      '<input data-field type="text" name="user_password" />',
      '<input data-field type="text" id="pwd" />',
      '<input data-field type="text" name="otpCode" />',
      '<input data-field type="text" id="verifyOTP" />',
      '<input data-field type="text" name="otp1" />',
      '<input data-field type="text" id="otp0" />',
      '<input data-field type="text" name="verify2FA" />',
      '<input data-field type="text" name="code2fa" />',
      '<input data-field type="text" name="oneTimeToken" />',
      '<input data-field type="text" name="twoFa" />',
      '<input data-field type="text" name="2fa_code" />',
      '<input data-field type="text" name="otpcode" />',
      '<input data-field autocomplete="billing cc-number" />',
      '<input data-field autocomplete="cc-csc" />',
      '<input data-field autocomplete="cc-exp" />'
    ]) {
      expect(readCapturableInputValue(field(html), policy("allow"))).toBeUndefined();
    }
  });

  it("never captures secret-named or card-named fields", () => {
    for (const html of [
      '<input data-field type="text" name="api_key" />',
      '<input data-field type="text" name="authToken" />',
      '<input data-field type="text" id="csrfField" />',
      '<input data-field type="text" name="pin" />',
      '<input data-field type="text" name="card_cvv" />',
      '<input data-field type="text" name="cardNumber" />',
      '<input data-field type="text" name="ſession" />'
    ]) {
      expect(readCapturableInputValue(field(html), policy("allow")), html).toBeUndefined();
    }

    for (const html of [
      '<input data-field name="city" />',
      '<input data-field name="spinner_speed" />',
      '<input data-field name="author_name" />'
    ]) {
      expect(readCapturableInputValue(field(html), policy("allow")), html).toBe("typed value");
    }
  });

  it("records every allowed field, passwords included, when content masking is off", () => {
    const raw = {
      ...policy("allow", { blockedSelectors: [] }),
      redaction: {
        ...DEFAULT_CAPTURE_POLICY.redaction,
        blockedSelectors: [],
        contentRedaction: false
      }
    };

    for (const html of [
      '<input data-field type="password" />',
      '<input data-field name="api_key" />',
      '<input data-field autocomplete="cc-number" />'
    ]) {
      expect(readCapturableInputValue(field(html), raw), html).toBe("typed value");
    }

    expect(
      readCapturableInputValue(field('<input data-field type="password" />'), policy("length-only"))
    ).toBeUndefined();
  });

  it("keeps secret-named fields when only the built-in heuristics are off", () => {
    const rules = {
      ...policy("allow"),
      redaction: { ...DEFAULT_CAPTURE_POLICY.redaction, builtInHeuristics: false }
    };

    expect(readCapturableInputValue(field('<input data-field name="api_key" />'), rules)).toBe(
      "typed value"
    );
    expect(
      readCapturableInputValue(field('<input data-field type="password" />'), rules)
    ).toBeUndefined();
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
