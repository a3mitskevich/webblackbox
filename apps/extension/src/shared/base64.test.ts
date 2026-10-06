import { afterEach, describe, expect, it } from "vitest";

import { base64DecodedLength, base64ToBytes, bytesToBase64 } from "./base64.js";

type NativeHooks = {
  toBase64?: unknown;
  fromBase64?: unknown;
};

const prototypeHooks = Uint8Array.prototype as unknown as NativeHooks;
const constructorHooks = Uint8Array as unknown as NativeHooks;
const originalToBase64 = prototypeHooks.toBase64;
const originalFromBase64 = constructorHooks.fromBase64;

function withoutNativeCodec(): void {
  Reflect.deleteProperty(prototypeHooks, "toBase64");
  Reflect.deleteProperty(constructorHooks, "fromBase64");
}

function sampleBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 31 + 7) & 0xff);
}

describe("base64", () => {
  afterEach(() => {
    if (originalToBase64 !== undefined) {
      prototypeHooks.toBase64 = originalToBase64;
    }

    if (originalFromBase64 !== undefined) {
      constructorHooks.fromBase64 = originalFromBase64;
    }
  });

  it("matches Node's encoder in both directions", () => {
    const bytes = sampleBytes(1_027);
    const expected = Buffer.from(bytes).toString("base64");

    expect(bytesToBase64(bytes)).toBe(expected);
    expect(Array.from(base64ToBytes(expected))).toEqual(Array.from(bytes));
  });

  it("encodes buffers larger than one fallback chunk without the native codec", () => {
    withoutNativeCodec();
    const bytes = sampleBytes(3 * 0x8000 + 5);

    const encoded = bytesToBase64(bytes);

    expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
    expect(Array.from(base64ToBytes(encoded))).toEqual(Array.from(bytes));
  });

  it("encodes a view into a larger buffer by its own bytes only", () => {
    const view = sampleBytes(64).subarray(10, 20);

    expect(base64ToBytes(bytesToBase64(view))).toEqual(Uint8Array.from(view));
  });

  it("handles empty input", () => {
    expect(bytesToBase64(new Uint8Array())).toBe("");
    expect(base64ToBytes("").byteLength).toBe(0);
  });

  it("knows the decoded length from the padding", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 100]) {
      expect(base64DecodedLength(bytesToBase64(sampleBytes(length)))).toBe(length);
    }
  });
});
