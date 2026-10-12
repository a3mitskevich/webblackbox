import { record } from "@rrweb/record";
import {
  maskValuePatterns,
  RRWEB_EVENT_SCHEMA,
  RRWEB_EVENT_TYPES,
  RRWEB_INCREMENTAL_SOURCES,
  type CapturePolicy,
  type RrwebRecordedEvent
} from "@webblackbox/protocol";

import { readCapturableInputValue } from "./input-value-policy.js";
import { monotonicTime } from "./lite-capture-config.js";
import type { DomRecorder, DomRecorderContext, DomRecorderFactory } from "./types.js";

type RrwebRecordOptions = NonNullable<Parameters<typeof record>[0]>;

/** The rrweb options that follow from a capture policy (everything except `emit`). */
export type RrwebPolicyOptions = Omit<RrwebRecordOptions, "emit">;

/** Batches leave the page at most this often (a full snapshot or a click leaves at once). */
export const RRWEB_BATCH_FLUSH_MS = 250;
/** A batch never holds more events than this. */
export const RRWEB_BATCH_MAX_EVENTS = 200;
/** A fresh full snapshot ("checkout") this often: seeking replays from the nearest one. */
export const RRWEB_CHECKOUT_EVERY_MS = 180_000;
/** Pointer moves are sampled to at most one position per this many ms. */
const MOUSEMOVE_SAMPLE_MS = 50;
const SCROLL_SAMPLE_MS = 150;
const MEDIA_SAMPLE_MS = 800;
/**
 * `dom: wireframe` keeps layout only: media is replaced by a placeholder of the same size
 * (rrweb's block), on top of the masked text.
 */
const WIREFRAME_BLOCKED_SELECTORS = [
  "img",
  "picture",
  "video",
  "audio",
  "canvas",
  "svg",
  "iframe",
  "object",
  "embed"
];

const maskAll = (text: string): string => text.replace(/\S/g, "*");

/**
 * A comma-joined selector list, or null when one selector is invalid: masking must fail closed,
 * and an invalid entry would make rrweb's `matches()` throw for the whole list.
 */
export function joinSelectors(selectors: readonly string[]): string | null {
  const trimmed = selectors.map((selector) => selector.trim()).filter(Boolean);

  for (const selector of trimmed) {
    try {
      document.createDocumentFragment().querySelector(selector);
    } catch {
      return null;
    }
  }

  return trimmed.join(", ");
}

function isEditableField(element: HTMLElement): element is HTMLInputElement | HTMLTextAreaElement {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

/** An input value as our input policy records it; rrweb asks for every value (`maskAllInputs`). */
function maskInputValue(text: string, element: HTMLElement, policy: CapturePolicy): string {
  const level = policy.categories.inputs;

  if (level === "none") {
    return "";
  }

  if (level === "length-only" || !isEditableField(element)) {
    return "*".repeat(text.length);
  }

  return readCapturableInputValue(element, policy) === undefined ? "*".repeat(text.length) : text;
}

/**
 * Maps our capture policy onto rrweb's record options. Returns null when the policy records no
 * DOM or a blocked selector is invalid (fail closed: no DOM log at all).
 *
 * - `blockedSelectors` → `blockSelector` (the element is kept as an empty box of the same size).
 * - `dom: masked` → every text node masked (`*` per character); `wireframe` also blocks media.
 * - `dom: allow` → text kept, with the user's DOM value patterns applied.
 * - inputs → `maskAllInputs` + `maskInputFn` with the same decision as `user.input` events.
 */
export function buildRrwebRecordOptions(policy: CapturePolicy): RrwebPolicyOptions | null {
  const { dom } = policy.categories;

  if (dom === "off") {
    return null;
  }

  const blockedSelectors = [
    ...policy.redaction.blockedSelectors,
    ...(dom === "wireframe" ? WIREFRAME_BLOCKED_SELECTORS : [])
  ];
  const blockSelector = joinSelectors(blockedSelectors);

  if (blockSelector === null) {
    return null;
  }

  const masksAllText = dom === "masked" || dom === "wireframe";
  const hasDomPatterns = (policy.redaction.valuePatterns ?? []).some((rule) =>
    rule.targets.includes("dom")
  );

  return {
    ...(blockSelector ? { blockSelector } : {}),
    ...(masksAllText || hasDomPatterns ? { maskTextSelector: "*" } : {}),
    maskTextFn: masksAllText ? maskAll : (text) => maskValuePatterns(text, policy.redaction, "dom"),
    maskAllInputs: true,
    maskInputFn: (text, element) => maskInputValue(text, element, policy),
    slimDOMOptions: "all",
    inlineStylesheet: true,
    recordCanvas: false,
    collectFonts: false,
    inlineImages: false,
    recordCrossOriginIframes: false,
    userTriggeredOnInput: true,
    checkoutEveryNms: RRWEB_CHECKOUT_EVERY_MS,
    sampling: {
      mousemove: MOUSEMOVE_SAMPLE_MS,
      scroll: SCROLL_SAMPLE_MS,
      media: MEDIA_SAMPLE_MS,
      input: "last"
    }
  };
}

function shouldFlushAt(event: RrwebRecordedEvent): boolean {
  if (event.type === RRWEB_EVENT_TYPES.fullSnapshot) {
    return true;
  }

  const data = event.data as { source?: unknown } | null;
  return (
    event.type === RRWEB_EVENT_TYPES.incrementalSnapshot &&
    data?.source === RRWEB_INCREMENTAL_SOURCES.mouseInteraction
  );
}

/**
 * Starts rrweb for a recording and emits its events in batches (`dom.rrweb.event`,
 * `schema: "rrweb/v2"`). Batches carry the page monotonic time of their first event, so the
 * Player can line rrweb timestamps up with the rest of the archive.
 */
export const createRrwebDomRecorder: DomRecorderFactory = (
  context: DomRecorderContext
): DomRecorder | null => {
  const options = buildRrwebRecordOptions(context.policy);

  if (!options) {
    return null;
  }

  let batch: RrwebRecordedEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    if (batch.length === 0) {
      return;
    }

    const events = batch;
    batch = [];
    const firstTimestamp = events[0]!.timestamp;
    const mono = monotonicTime() - Math.max(0, Date.now() - firstTimestamp);
    context.emit({ schema: RRWEB_EVENT_SCHEMA, events }, mono);
  };

  const stopRecording = record({
    ...options,
    emit: (event) => {
      const recorded = event as RrwebRecordedEvent;
      batch = [...batch, recorded];

      if (shouldFlushAt(recorded) || batch.length >= RRWEB_BATCH_MAX_EVENTS) {
        flush();
        return;
      }

      flushTimer ??= setTimeout(flush, RRWEB_BATCH_FLUSH_MS);
    },
    // A recorder error must never break the page; rrweb then skips that observation.
    errorHandler: () => true
  });

  return {
    flush,
    stop: () => {
      stopRecording?.();
      flush();
    }
  };
};
