import { snapdom } from "@zumer/snapdom";

const SCREENSHOT_MAX_DATA_URL_LENGTH = 10 * 1024 * 1024;
const SCREENSHOT_CAPTURE_TIMEOUT_MS = 4_000;
const SCREENSHOT_MAX_DIMENSION_PX = 1_200;
const SCREENSHOT_MAX_SCALE = 1.5;
const SCREENSHOT_MIN_SCALE = 0.45;
const SCREENSHOT_WEBP_QUALITY = 0.66;

/** What the agent provides while one viewport screenshot is taken. */
export type ViewportScreenshotHost = {
  /** The recording indicator (hidden while the page is captured), read when it is needed. */
  indicator(): HTMLElement | null;
  /** snapdom started cloning the page: no other screenshot may start until it settles. */
  onCaptureStarted(): void;
  onCaptureSettled(): void;
  pointer(): Record<string, unknown> | undefined;
  emit(payload: Record<string, unknown>): void;
};

/** Captures the viewport with snapdom and emits it, unless it times out or is too large. */
export async function captureViewportScreenshot(
  reason: string,
  host: ViewportScreenshotHost
): Promise<void> {
  const root = document.documentElement;
  const viewportWidth = Math.max(1, Math.round(window.innerWidth));
  const viewportHeight = Math.max(1, Math.round(window.innerHeight));
  const scale = computeScreenshotScale(viewportWidth, viewportHeight, window.devicePixelRatio || 1);
  const captureWidth = Math.max(1, Math.round(viewportWidth * scale));
  const captureHeight = Math.max(1, Math.round(viewportHeight * scale));
  const snapdomCaptureOptions = createSnapdomCaptureOptions(scale);

  const indicator = host.indicator();
  const previousIndicatorVisibility = indicator?.style.visibility;

  if (indicator) {
    indicator.style.visibility = "hidden";
  }

  try {
    const captureTask = captureSnapdomDataUrl(root, snapdomCaptureOptions, {
      width: captureWidth,
      height: captureHeight
    });
    host.onCaptureStarted();
    void captureTask.then(
      () => {
        host.onCaptureSettled();
      },
      () => {
        host.onCaptureSettled();
      }
    );

    const screenshot = await withTimeout(captureTask, SCREENSHOT_CAPTURE_TIMEOUT_MS);

    if (
      !screenshot ||
      typeof screenshot.dataUrl !== "string" ||
      screenshot.dataUrl.length > SCREENSHOT_MAX_DATA_URL_LENGTH
    ) {
      return;
    }

    host.emit({
      reason,
      dataUrl: screenshot.dataUrl,
      format: screenshot.format,
      quality: screenshot.quality,
      w: captureWidth,
      h: captureHeight,
      viewport: {
        width: viewportWidth,
        height: viewportHeight,
        dpr: Number((window.devicePixelRatio || 1).toFixed(3))
      },
      pointer: host.pointer()
    });
  } catch {
    void 0;
  } finally {
    const shownIndicator = host.indicator();

    if (shownIndicator) {
      shownIndicator.style.visibility = previousIndicatorVisibility ?? "";
    }
  }
}

function computeScreenshotScale(
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

function createSnapdomCaptureOptions(scale: number): SnapdomCaptureOptions {
  return {
    fast: true,
    cache: "auto",
    dpr: 1,
    scale,
    backgroundColor: "transparent"
  };
}

async function captureSnapdomDataUrl(
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

function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T | null> {
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
