import { describe, expect, it } from "vitest";

import { decodeScreenshotDataUrl } from "./screenshot-data-url.js";

const BYTES = [1, 2, 3, 4];
const BASE64 = Buffer.from(BYTES).toString("base64");

describe("decodeScreenshotDataUrl", () => {
  it("decodes png and webp screenshots", () => {
    expect(decodeScreenshotDataUrl(`data:image/png;base64,${BASE64}`)).toEqual({
      mime: "image/png",
      format: "png",
      bytes: Uint8Array.from(BYTES)
    });
    expect(decodeScreenshotDataUrl(`data:IMAGE/WebP;base64,${BASE64}`)).toEqual({
      mime: "image/webp",
      format: "webp",
      bytes: Uint8Array.from(BYTES)
    });
  });

  it("drops non-image and unsupported image payloads", () => {
    expect(decodeScreenshotDataUrl(`data:text/html;base64,${BASE64}`)).toBeNull();
    expect(decodeScreenshotDataUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(decodeScreenshotDataUrl(`data:image/svg+xml;base64,${BASE64}`)).toBeNull();
    expect(decodeScreenshotDataUrl(`data:application/octet-stream;base64,${BASE64}`)).toBeNull();
    expect(decodeScreenshotDataUrl(`data:;base64,${BASE64}`)).toBeNull();
  });

  it("requires base64 data urls", () => {
    expect(decodeScreenshotDataUrl("data:image/png,%01%02")).toBeNull();
    expect(decodeScreenshotDataUrl(`https://evil.example/shot.png`)).toBeNull();
    expect(decodeScreenshotDataUrl("data:image/png;base64")).toBeNull();
  });

  it("rejects malformed base64", () => {
    expect(decodeScreenshotDataUrl("data:image/png;base64,***")).toBeNull();
  });
});
