import { record } from "@rrweb/record";
import {
  RRWEB_EVENT_SCHEMA,
  RRWEB_EVENT_TYPES,
  RRWEB_INCREMENTAL_SOURCES,
  type CapturePolicy,
  type RrwebRecordedEvent,
  type RrwebRecorderReason,
  type RrwebRecorderState
} from "@webblackbox/protocol";

import { readCapturableInputValue } from "./input-value-policy.js";
import { monotonicTime } from "./lite-capture-config.js";
import { buildRrwebTextMask, createRrwebEventMask, needsRrwebEventMask } from "./rrweb-masking.js";
import {
  countMutationChanges,
  DOM_RECORDER_MAX_ELEMENTS,
  RrwebPressureGauge,
  type RrwebPressureReason
} from "./rrweb-pressure.js";
import type { DomRecorder, DomRecorderContext, DomRecorderFactory } from "./types.js";

type RrwebRecordOptions = NonNullable<Parameters<typeof record>[0]>;

/** The rrweb options that follow from a capture policy (everything except `emit`). */
export type RrwebPolicyOptions = Omit<RrwebRecordOptions, "emit">;

/** Batches leave the page at most this often (a full snapshot or a click leaves at once). */
export const RRWEB_BATCH_FLUSH_MS = 250;
/** A batch never holds more events than this. */
export const RRWEB_BATCH_MAX_EVENTS = 200;
/** A batch leaves early once its mutations carry this many changes (nodes, texts, attributes). */
export const RRWEB_BATCH_MAX_CHANGES = 2_000;
/**
 * A fresh full snapshot ("checkout") this often: replay and the headless DOM rebuild start from the
 * nearest one, so this bounds seek time. 2 min keeps seeks on a ~10k-element page well under a
 * second at the cost of one snapshot (tens of KB compressed on ordinary pages) per period.
 */
export const RRWEB_CHECKOUT_EVERY_MS = 120_000;
/** ... and after this many incremental events, for pages that change a lot between periods. */
export const RRWEB_CHECKOUT_EVERY_EVENTS = 5_000;
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

/** Our own recording indicator never belongs to the recorded page (the raw DOM drops it too). */
const OWN_UI_SELECTOR = "[data-webblackbox-indicator]";

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
 * - `dom: allow` → text kept, under the raw DOM's heuristics and the user's DOM value patterns
 *   while the profile masks content; as it is otherwise (Full capture).
 * - inputs → `maskAllInputs` + `maskInputFn` with the same decision as `user.input` events; rich
 *   editors are masked like fields.
 *
 * Attribute values, style text and hidden fields are masked on the emitted events
 * (`rrweb-masking.ts`): rrweb has no option for them.
 */
export function buildRrwebRecordOptions(policy: CapturePolicy): RrwebPolicyOptions | null {
  const { dom } = policy.categories;

  if (dom === "off") {
    return null;
  }

  const blockedSelectors = [
    OWN_UI_SELECTOR,
    ...policy.redaction.blockedSelectors,
    ...(dom === "wireframe" ? WIREFRAME_BLOCKED_SELECTORS : [])
  ];
  const blockSelector = joinSelectors(blockedSelectors);

  if (blockSelector === null) {
    return null;
  }

  const maskTextFn = buildRrwebTextMask(policy);

  return {
    blockSelector,
    ...(maskTextFn ? { maskTextSelector: "*", maskTextFn } : {}),
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
    checkoutEveryNth: RRWEB_CHECKOUT_EVERY_EVENTS,
    sampling: {
      mousemove: MOUSEMOVE_SAMPLE_MS,
      scroll: SCROLL_SAMPLE_MS,
      media: MEDIA_SAMPLE_MS,
      input: "last"
    }
  };
}

function isMutationEvent(event: RrwebRecordedEvent): boolean {
  const data = event.data as { source?: unknown } | null;
  return (
    event.type === RRWEB_EVENT_TYPES.incrementalSnapshot &&
    data?.source === RRWEB_INCREMENTAL_SOURCES.mutation
  );
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

/** Elements of the page (cheap: one live collection length). */
export function countPageElements(doc: Document = document): number {
  return doc.getElementsByTagName("*").length;
}

/**
 * Measures rrweb's main-thread time per mutation delivery. Mutation observers are notified in the
 * order they were created, so this observer, created right before rrweb's, marks the start of a
 * delivery and rrweb's emit callback (the end of its processing) reads the elapsed time. The mark
 * is cleared after the delivery, so an emit outside one (a checkout) reads no cost.
 */
type CostProbe = { read: () => number; disconnect: () => void };

function createCostProbe(): CostProbe {
  let startedAt = -1;
  const observer = new MutationObserver(() => {
    startedAt = performance.now();
    queueMicrotask(() => {
      startedAt = -1;
    });
  });
  observer.observe(document, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true
  });

  return {
    read: () => (startedAt < 0 ? 0 : performance.now() - startedAt),
    disconnect: () => {
      observer.disconnect();
      startedAt = -1;
    }
  };
}

/** Test seam: the clock and timers the recorder uses. */
export type RrwebRecorderRuntime = {
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
  countElements: () => number;
};

const DEFAULT_RUNTIME: RrwebRecorderRuntime = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer),
  countElements: () => countPageElements()
};

/**
 * Starts rrweb for a recording and emits its events in batches (`dom.rrweb.event`,
 * `schema: "rrweb/v2"`). Batches carry the page monotonic time of their first event, so the
 * Player can line rrweb timestamps up with the rest of the archive.
 *
 * Pressure mode (`rrweb-pressure.ts`): rrweb pauses while its main-thread time or one change set
 * is over budget and resumes with a fresh full snapshot; a page over the element limit is not
 * recorded by rrweb (`null`, after a `disabled` batch), nor is one that grows over it by the next
 * resume (`context.onDisabled`).
 */
export function createRrwebDomRecorderWith(
  context: DomRecorderContext,
  runtime: RrwebRecorderRuntime = DEFAULT_RUNTIME
): DomRecorder | null {
  const options = buildRrwebRecordOptions(context.policy);

  if (!options) {
    return null;
  }

  const elements = runtime.countElements();

  if (elements > DOM_RECORDER_MAX_ELEMENTS) {
    emitState(context, { status: "disabled", reason: "element-limit", elements });
    return null;
  }

  const maskEvent = needsRrwebEventMask(context.policy)
    ? createRrwebEventMask(context.policy, (id) => record.mirror.getNode(id))
    : (event: RrwebRecordedEvent) => event;
  const gauge = new RrwebPressureGauge();
  let batch: RrwebRecordedEvent[] = [];
  let batchChanges = 0;
  let batchState: RrwebRecorderState | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  let stopRecording: (() => void) | null = null;
  let probe: CostProbe | null = null;
  let status: "recording" | "paused" | "stopped" | "disabled" = "recording";

  const flush = (): void => {
    if (flushTimer !== null) {
      runtime.clearTimeout(flushTimer);
      flushTimer = null;
    }

    if (batch.length === 0 && batchState === undefined) {
      return;
    }

    const events = batch;
    const state = batchState;
    batch = [];
    batchChanges = 0;
    batchState = undefined;
    const firstTimestamp = events[0]?.timestamp ?? Date.now();
    const mono = monotonicTime() - Math.max(0, Date.now() - firstTimestamp);
    context.emit(
      { schema: RRWEB_EVENT_SCHEMA, events, ...(state ? { recorder: state } : {}) },
      mono
    );
  };

  const halt = (): void => {
    const stop = stopRecording;
    stopRecording = null;
    probe?.disconnect();
    probe = null;
    stop?.();
  };

  const pause = (reason: RrwebPressureReason, costMs: number): void => {
    halt();
    status = "paused";
    batchState = {
      status: "paused",
      reason,
      ...(reason === "mutation-cost" ? { costMs: Math.round(costMs) } : {})
    };
    flush();
    resumeTimer = runtime.setTimeout(resume, gauge.startPause(runtime.now()));
  };

  const disable = (reason: RrwebRecorderReason, extra: { elements?: number } = {}): void => {
    halt();
    status = "disabled";
    batchState = { status: "disabled", reason, ...extra };
    flush();
    context.onDisabled();
  };

  const onEvent = (event: RrwebRecordedEvent): void => {
    if (status !== "recording") {
      return;
    }

    if (isMutationEvent(event)) {
      const changes = countMutationChanges(event.data);
      const verdict = gauge.measureMutation(probe?.read() ?? 0, changes, runtime.now());

      if (verdict.pause) {
        // An oversized change set never leaves the page; the next full snapshot covers it.
        if (verdict.reason === "mutation-cost") {
          batch = [...batch, maskEvent(event)];
        }

        pause(verdict.reason, verdict.costMs);
        return;
      }

      batchChanges += changes;
    }

    const recorded = maskEvent(event);
    batch = [...batch, recorded];

    if (
      shouldFlushAt(recorded) ||
      batch.length >= RRWEB_BATCH_MAX_EVENTS ||
      batchChanges >= RRWEB_BATCH_MAX_CHANGES
    ) {
      flush();
      return;
    }

    flushTimer ??= runtime.setTimeout(flush, RRWEB_BATCH_FLUSH_MS);
  };

  /** Starts rrweb (its first events are a meta and a full snapshot); false when it cannot. */
  const start = (): boolean => {
    probe = createCostProbe();

    try {
      stopRecording =
        record({
          ...options,
          emit: (event) => onEvent(event as RrwebRecordedEvent),
          // A recorder error must never break the page; rrweb then skips that observation.
          errorHandler: () => true
        }) ?? null;
    } catch {
      stopRecording = null;
    }

    if (!stopRecording) {
      probe.disconnect();
      probe = null;
      return false;
    }

    return true;
  };

  function resume(): void {
    resumeTimer = null;

    if (status !== "paused") {
      return;
    }

    const count = runtime.countElements();

    if (count > DOM_RECORDER_MAX_ELEMENTS) {
      disable("element-limit", { elements: count });
      return;
    }

    status = "recording";
    gauge.markResumed(runtime.now());
    // Carried by the batch that starts with the fresh full snapshot.
    batchState = { status: "resumed" };

    if (!start()) {
      disable("start-failed");
    }
  }

  if (!start()) {
    emitState(context, { status: "disabled", reason: "start-failed" });
    return null;
  }

  return {
    flush,
    stop: () => {
      if (resumeTimer !== null) {
        runtime.clearTimeout(resumeTimer);
        resumeTimer = null;
      }

      if (status === "recording") {
        halt();
      }

      status = "stopped";
      flush();
    },
    checkpoint: () => {
      if (status !== "recording") {
        return;
      }

      try {
        record.takeFullSnapshot(true);
      } catch {
        // Not recording yet (rrweb waits for the page to load): its first snapshot is still due.
      }
    }
  };
}

function emitState(context: DomRecorderContext, state: RrwebRecorderState): void {
  context.emit({ schema: RRWEB_EVENT_SCHEMA, events: [], recorder: state }, monotonicTime());
}

/** {@link createRrwebDomRecorderWith} on the real clock and timers. */
export const createRrwebDomRecorder: DomRecorderFactory = (context) =>
  createRrwebDomRecorderWith(context);
