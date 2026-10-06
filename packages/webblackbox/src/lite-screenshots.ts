import { snapdom } from "@zumer/snapdom";

const SCREENSHOT_MAX_DIMENSION_PX = 1_200;
const SCREENSHOT_MAX_SCALE = 1.5;
const SCREENSHOT_MIN_SCALE = 0.45;
const SCREENSHOT_WEBP_QUALITY = 0.66;

export function computeScreenshotScale(
  viewportWidth: number,
  viewportHeight: number,
  dpr: number
): number {
  const baseScale = Math.max(1, dpr || 1);
  const dimensionScale = Math.min(
    1,
    SCREENSHOT_MAX_DIMENSION_PX / Math.max(viewportWidth, viewportHeight)
  );

  return Math.max(
    SCREENSHOT_MIN_SCALE,
    Math.min(SCREENSHOT_MAX_SCALE, Number((baseScale * dimensionScale).toFixed(3)))
  );
}

type SnapdomBlobOptions = Parameters<typeof snapdom.toBlob>[1];
type SnapdomCaptureOptions = Omit<NonNullable<SnapdomBlobOptions>, "type" | "quality">;
type ScreenshotCropTarget = {
  width: number;
  height: number;
};

export function createSnapdomCaptureOptions(scale: number): SnapdomCaptureOptions {
  return {
    fast: true,
    cache: "auto",
    dpr: 1,
    scale,
    backgroundColor: "transparent"
  };
}

export async function captureSnapdomDataUrl(
  element: Element,
  options: SnapdomCaptureOptions,
  cropTarget: ScreenshotCropTarget
): Promise<{ dataUrl: string; format: "webp" | "png"; quality?: number } | null> {
  const webpDataUrl = await captureSnapdomFormatDataUrl(
    element,
    {
      ...options,
      type: "webp",
      quality: SCREENSHOT_WEBP_QUALITY
    },
    {
      ...cropTarget,
      mimeType: "image/webp",
      quality: SCREENSHOT_WEBP_QUALITY
    }
  );

  if (webpDataUrl) {
    return {
      dataUrl: webpDataUrl,
      format: "webp",
      quality: Math.round(SCREENSHOT_WEBP_QUALITY * 100)
    };
  }

  const pngDataUrl = await captureSnapdomFormatDataUrl(
    element,
    {
      ...options,
      type: "png"
    },
    {
      ...cropTarget,
      mimeType: "image/png"
    }
  );

  if (!pngDataUrl) {
    return null;
  }

  return {
    dataUrl: pngDataUrl,
    format: "png"
  };
}

async function captureSnapdomFormatDataUrl(
  element: Element,
  options: NonNullable<SnapdomBlobOptions>,
  cropTarget: ScreenshotCropTarget & { mimeType: string; quality?: number }
): Promise<string | null> {
  const blob = await safeSnapdomToBlob(element, options);
  return cropBlobToDataUrl(blob, cropTarget);
}

async function safeSnapdomToBlob(
  element: Element,
  options: NonNullable<SnapdomBlobOptions>
): Promise<Blob | null> {
  try {
    const blob = await snapdom.toBlob(element, options);
    return blob instanceof Blob ? blob : null;
  } catch {
    return null;
  }
}

export function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return Promise.race<T | null>([
    task,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        resolve(null);
      }, timeoutMs);
    })
  ]).finally(() => {
    if (timer !== null) {
      clearTimeout(timer);
    }
  });
}

async function cropBlobToDataUrl(
  blob: Blob | null,
  options: ScreenshotCropTarget & { mimeType: string; quality?: number }
): Promise<string | null> {
  if (!(blob instanceof Blob)) {
    return null;
  }

  const objectUrl = URL.createObjectURL(blob);

  try {
    const image = await loadImageFromUrl(objectUrl);
    const targetWidth = Math.max(1, Math.round(options.width));
    const targetHeight = Math.max(1, Math.round(options.height));
    const sourceWidth = Math.max(1, Math.round(image.naturalWidth || image.width || targetWidth));
    const sourceHeight = Math.max(
      1,
      Math.round(image.naturalHeight || image.height || targetHeight)
    );
    const cropWidth = Math.max(1, Math.min(targetWidth, sourceWidth));
    const cropHeight = Math.max(1, Math.min(targetHeight, sourceHeight));
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const context = canvas.getContext("2d");

    if (!context) {
      return null;
    }

    context.clearRect(0, 0, targetWidth, targetHeight);
    context.drawImage(image, 0, 0, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

    return safeCanvasToDataUrl(canvas, options.mimeType, options.quality);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      resolve(image);
    };
    image.onerror = () => {
      reject(new Error("image-load-failed"));
    };
    image.src = url;
  });
}

function safeCanvasToDataUrl(
  canvas: HTMLCanvasElement,
  format: string,
  quality?: number
): string | null {
  try {
    return typeof quality === "number"
      ? canvas.toDataURL(format, quality)
      : canvas.toDataURL(format);
  } catch {
    return null;
  }
}
