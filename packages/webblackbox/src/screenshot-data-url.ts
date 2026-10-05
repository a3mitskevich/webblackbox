export type ScreenshotImageFormat = "png" | "webp";

export type DecodedScreenshotDataUrl = {
  mime: string;
  format: ScreenshotImageFormat;
  bytes: Uint8Array;
};

/**
 * Image types accepted for page-side screenshots. Limited to what the screenshot
 * event schema can describe (`format: "png" | "webp"`); anything else — notably
 * `data:text/html` forged through the page channel — is dropped before it reaches
 * blob storage and, later, the player.
 */
const SCREENSHOT_IMAGE_FORMATS: ReadonlyMap<string, ScreenshotImageFormat> = new Map([
  ["image/png", "png"],
  ["image/webp", "webp"]
]);

export function decodeScreenshotDataUrl(dataUrl: string): DecodedScreenshotDataUrl | null {
  if (!dataUrl.startsWith("data:")) {
    return null;
  }

  const commaIndex = dataUrl.indexOf(",");

  if (commaIndex <= 5) {
    return null;
  }

  const segments = dataUrl.slice(5, commaIndex).split(";");
  const mime = (segments[0] ?? "").trim().toLowerCase();
  const format = SCREENSHOT_IMAGE_FORMATS.get(mime);

  if (!format || !segments.slice(1).some((segment) => segment.trim() === "base64")) {
    return null;
  }

  const bytes = decodeBase64(dataUrl.slice(commaIndex + 1));
  return bytes ? { mime, format, bytes } : null;
}

function decodeBase64(value: string): Uint8Array | null {
  if (typeof atob !== "function") {
    return null;
  }

  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  } catch {
    return null;
  }
}
