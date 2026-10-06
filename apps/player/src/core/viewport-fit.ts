import type { WebBlackboxEvent } from "@webblackbox/protocol";

import { asFiniteNumber, asRecord } from "../lib/parsing.js";
import { upperBoundByMono } from "../lib/range.js";
import { inferEventScope } from "../lib/scope.js";

/**
 * Where the recorded page sits inside a stage frame. Pointer, click and target coordinates are
 * CSS pixels of the page viewport (`user.resize`, a pointer event's `viewport`). The tab video has
 * its own frame size (Chrome's tab capture: 2560×1440 unless constrained) and fits the page into
 * it keeping its aspect ratio, centred, with bars on two sides — e.g. when DevTools took part of
 * the window. A screenshot is the viewport itself, so the fit is the whole image.
 */

export type FrameSize = { width: number; height: number };

/** The page viewport in CSS pixels; `dpr` is informational (the fit does not depend on it). */
export type ViewportSize = { width: number; height: number; dpr?: number | null };

/** The page viewport from `mono` on (until the next sample). */
export type ViewportSample = { mono: number; width: number; height: number; dpr: number | null };

/** A rectangle in frame pixels. */
export type FrameRect = { x: number; y: number; width: number; height: number };

/** Pointer events whose `viewport { w, h, dpr }` is the page's when recorded in the top frame. */
const VIEWPORT_POINTER_TYPES = new Set<string>([
  "user.click",
  "user.dblclick",
  "user.contextmenu",
  "user.auxclick",
  "user.pointerdown",
  "user.pointerup"
]);

function isUsableSize(size: ViewportSize | null | undefined): size is ViewportSize {
  return (
    size !== null &&
    size !== undefined &&
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width > 0 &&
    size.height > 0
  );
}

/**
 * The page's rectangle inside a frame of `frame` pixels: aspect-fit and centred. Device pixels
 * scale both sides alike, so `dpr` cancels out. Without a usable viewport: the whole frame.
 */
export function fitContentRect(frame: FrameSize, viewport: ViewportSize | null): FrameRect {
  if (!isUsableSize(viewport) || !isUsableSize(frame)) {
    return { x: 0, y: 0, width: frame.width, height: frame.height };
  }

  const scale = Math.min(frame.width / viewport.width, frame.height / viewport.height);
  const width = viewport.width * scale;
  const height = viewport.height * scale;

  return { x: (frame.width - width) / 2, y: (frame.height - height) / 2, width, height };
}

/** A point in viewport CSS pixels → frame pixels. */
export function projectToFrame(
  frame: FrameSize,
  viewport: ViewportSize | null,
  point: { x: number; y: number }
): { x: number; y: number } {
  const rect = fitContentRect(frame, viewport);
  const sourceWidth = isUsableSize(viewport) ? viewport.width : frame.width;
  const sourceHeight = isUsableSize(viewport) ? viewport.height : frame.height;

  return {
    x: rect.x + (point.x / sourceWidth) * rect.width,
    y: rect.y + (point.y / sourceHeight) * rect.height
  };
}

/** The viewport an event reports for the top frame, or `null`. */
function readViewportSample(event: WebBlackboxEvent): ViewportSample | null {
  const data = asRecord(event.data);

  if (event.type === "user.resize") {
    return toSample(event.mono, data?.width, data?.height, data?.dpr);
  }

  // An iframe's pointer event reports the iframe's own viewport. A same-origin one carries its
  // frame offset; a cross-origin one cannot read it, but is recorded in a sub-frame.
  if (
    VIEWPORT_POINTER_TYPES.has(event.type) &&
    data?.frameOffset === undefined &&
    inferEventScope(event) === "main"
  ) {
    const viewport = asRecord(data?.viewport);
    return viewport ? toSample(event.mono, viewport.w, viewport.h, viewport.dpr) : null;
  }

  return null;
}

function toSample(
  mono: number,
  width: unknown,
  height: unknown,
  dpr: unknown
): ViewportSample | null {
  const size = { width: asFiniteNumber(width) ?? 0, height: asFiniteNumber(height) ?? 0 };
  return isUsableSize(size) ? { mono, ...size, dpr: asFiniteNumber(dpr) } : null;
}

/** The page viewport over time (top frame only), with consecutive repeats dropped. */
export function buildViewportTimeline(events: readonly WebBlackboxEvent[]): ViewportSample[] {
  const samples = events
    .flatMap((event) => {
      const sample = readViewportSample(event);
      return sample ? [sample] : [];
    })
    .sort((left, right) => left.mono - right.mono);

  return samples.filter((sample, index) => {
    const previous = samples[index - 1];
    return !previous || previous.width !== sample.width || previous.height !== sample.height;
  });
}

/**
 * The viewport at `mono`: the latest sample at or before it; before the first sample, the first
 * one (the page had some size from the start). `null` when the archive records none.
 */
export function resolveViewportAt(
  timeline: readonly ViewportSample[],
  mono: number
): ViewportSample | null {
  const index = upperBoundByMono(timeline, mono, (sample) => sample.mono) - 1;
  return timeline[Math.max(0, index)] ?? null;
}
