import {
  POINTER_DRAG_THRESHOLD_PX,
  allowsSelectionText,
  POINTER_LONG_PRESS_MS,
  SELECTION_TEXT_MAX_CHARS,
  type CapturePolicy,
  type PointerCaptureOptions,
  type PointerKind
} from "@webblackbox/protocol";

import { isCoveredByBlockedSelector, isNeverCapturedField } from "./input-value-policy.js";
import {
  readFrameOffset,
  readViewportGeometry,
  resolveInteractiveElement,
  round
} from "./pointer-target.js";

/** How long a click is watched for a DOM reaction (dead-click detection). */
export const CLICK_REACTION_WINDOW_MS = 1_000;
/** Pointer rest over one interactive element from which a hover is recorded. */
export const HOVER_DWELL_MIN_MS = 500;
/** Quiet gap that closes a wheel burst. */
export const WHEEL_BURST_IDLE_MS = 150;
/** Longest wheel burst folded into one event. */
export const WHEEL_BURST_MAX_MS = 1_000;
/** Settle time before a selection change is read. */
export const SELECTION_SETTLE_MS = 300;

const MAX_ACTIVE_REACTION_PROBES = 4;
const MAX_TRACKED_PRESSES = 10;
const HOVER_DWELL_MAX_MS = 60_000;
const WEBBLACKBOX_INDICATOR_SELECTOR = "[data-webblackbox-indicator]";
const PASSIVE_CAPTURE: AddEventListenerOptions = { capture: true, passive: true };
const CAPTURE: AddEventListenerOptions = { capture: true };

/** Target payload detail: `rich` adds rect and readable labels, `fast` is hashed only. */
export type PointerTargetDetail = "rich" | "fast";

/** What the capture agent provides to the pointer controller. */
export type PointerCaptureHost = {
  options(): PointerCaptureOptions;
  policy(): CapturePolicy;
  isRecording(): boolean;
  emit(rawType: string, payload: Record<string, unknown>, mono?: number): void;
  targetPayload(target: EventTarget | null, detail: PointerTargetDetail): Record<string, unknown>;
  listen<TEvent extends Event>(
    target: EventTarget,
    type: string,
    listener: (event: TEvent) => void,
    options?: AddEventListenerOptions
  ): void;
  markUserActivity(): void;
  trackPointer(x: number, y: number): void;
  now(): number;
};

type PressState = {
  pointerType: PointerKind;
  button: number;
  startX: number;
  startY: number;
  startMono: number;
  maxDistance: number;
  dragStarted: boolean;
  dnd: boolean;
  target: Record<string, unknown>;
};

type DndState = {
  startX: number;
  startY: number;
  startMono: number;
  dropTarget?: Record<string, unknown>;
  dropX?: number;
  dropY?: number;
};

type WheelBurst = {
  startMono: number;
  lastMono: number;
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  count: number;
  zoom: boolean;
  x: number;
  y: number;
  modifiers: Record<string, boolean>;
  target: EventTarget | null;
};

type HoverState = {
  element: Element;
  enterMono: number;
  x: number;
  y: number;
};

type ReactionProbe = {
  observer: MutationObserver;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Captures pointer presses, right/middle clicks, drags, drag-and-drop, selections, wheel bursts,
 * hover dwell and click reactions. The noisier streams follow the profile's `pointer.*` options,
 * read on every event so a mid-session profile switch applies at once.
 */
export class PointerCaptureController {
  private readonly presses = new Map<number, PressState>();
  private readonly reactionProbes = new Set<ReactionProbe>();
  private dnd: DndState | null = null;
  private wheelBurst: WheelBurst | null = null;
  private wheelTimer: ReturnType<typeof setTimeout> | null = null;
  private hover: HoverState | null = null;
  private selectionTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSelectionKey = "";

  public constructor(private readonly host: PointerCaptureHost) {}

  /** Registers listeners through the host so the agent's teardown removes them. */
  public install(): void {
    const { host } = this;

    host.listen<PointerEvent>(
      document,
      "pointerdown",
      (event) => this.onPointerDown(event),
      CAPTURE
    );
    host.listen<PointerEvent>(
      document,
      "pointerup",
      (event) => this.onPointerUp(event, false),
      CAPTURE
    );
    host.listen<PointerEvent>(
      document,
      "pointercancel",
      (event) => this.onPointerUp(event, true),
      CAPTURE
    );
    host.listen<MouseEvent>(
      document,
      "contextmenu",
      (event) => this.onAuxAction("contextmenu", event),
      CAPTURE
    );
    host.listen<MouseEvent>(
      document,
      "auxclick",
      (event) => this.onAuxAction("auxclick", event),
      CAPTURE
    );
    host.listen<WheelEvent>(document, "wheel", (event) => this.onWheel(event), PASSIVE_CAPTURE);
    host.listen<DragEvent>(document, "dragstart", (event) => this.onDragStart(event), CAPTURE);
    host.listen<DragEvent>(document, "drop", (event) => this.onDrop(event), CAPTURE);
    host.listen<DragEvent>(document, "dragend", (event) => this.onDragEnd(event), CAPTURE);
    host.listen<Event>(
      document,
      "selectionchange",
      () => this.onSelectionChange(),
      PASSIVE_CAPTURE
    );
    host.listen<PointerEvent>(
      document,
      "pointerover",
      (event) => this.onPointerOver(event),
      PASSIVE_CAPTURE
    );
    host.listen<PointerEvent>(
      document,
      "pointerout",
      (event) => this.onPointerOut(event),
      PASSIVE_CAPTURE
    );
  }

  /** Called for every pointermove before the agent's sampling, to follow held pointers. */
  public onPointerMove(event: PointerEvent): void {
    const press = this.presses.get(readPointerId(event));

    if (!press) {
      return;
    }

    const distance = Math.hypot(event.clientX - press.startX, event.clientY - press.startY);
    press.maxDistance = Math.max(press.maxDistance, distance);

    if (
      press.dragStarted ||
      press.dnd ||
      distance < POINTER_DRAG_THRESHOLD_PX ||
      !this.host.options().drag
    ) {
      return;
    }

    press.dragStarted = true;
    this.host.emit("dragStart", {
      kind: "pointer",
      pointerType: press.pointerType,
      x: press.startX,
      y: press.startY,
      ...readGeometry(),
      target: { ...press.target }
    });
  }

  /** Starts a reaction probe for a click queued at `clickMono`. */
  public onClick(clickMono: number): void {
    if (
      typeof MutationObserver === "undefined" ||
      this.reactionProbes.size >= MAX_ACTIVE_REACTION_PROBES
    ) {
      return;
    }

    const root = document.documentElement;
    let settled = false;

    const finish = (mutated: boolean): void => {
      if (settled) {
        return;
      }

      settled = true;
      probe.observer.disconnect();
      clearTimeout(probe.timer);
      this.reactionProbes.delete(probe);

      if (!this.host.isRecording()) {
        return;
      }

      const latencyMs = Math.max(0, this.host.now() - clickMono);
      this.host.emit("clickReaction", {
        clickMono,
        mutated,
        ...(mutated ? { latencyMs: round(latencyMs) } : {}),
        windowMs: CLICK_REACTION_WINDOW_MS
      });
    };

    const probe: ReactionProbe = {
      observer: new MutationObserver((records) => {
        if (records.some((record) => !isOwnIndicatorMutation(record))) {
          finish(true);
        }
      }),
      timer: setTimeout(() => finish(false), CLICK_REACTION_WINDOW_MS)
    };

    probe.observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true
    });
    this.reactionProbes.add(probe);
  }

  /** Emits a pending wheel burst and hover dwell (call while still recording). */
  public flushPending(): void {
    this.flushWheelBurst();
    this.finishHover();
  }

  /** Drops gesture state and stops timers and reaction probes (capture torn down). */
  public reset(): void {
    this.wheelBurst = null;
    this.hover = null;

    if (this.wheelTimer !== null) {
      clearTimeout(this.wheelTimer);
      this.wheelTimer = null;
    }

    if (this.selectionTimer !== null) {
      clearTimeout(this.selectionTimer);
      this.selectionTimer = null;
    }

    for (const probe of this.reactionProbes) {
      probe.observer.disconnect();
      clearTimeout(probe.timer);
    }

    this.reactionProbes.clear();
    this.presses.clear();
    this.dnd = null;
    this.lastSelectionKey = "";
  }

  private onPointerDown(event: PointerEvent): void {
    const { host } = this;
    host.markUserActivity();
    host.trackPointer(event.clientX, event.clientY);

    const pointerType = readPointerType(event);
    const target = host.targetPayload(event.target, "rich");

    host.emit("pointerdown", {
      ...readPointerBase(event),
      pointerType,
      pointerId: readPointerId(event),
      button: event.button,
      buttons: event.buttons,
      ...readModifiers(event),
      target
    });

    if (this.presses.size >= MAX_TRACKED_PRESSES) {
      this.presses.clear();
    }

    this.presses.set(readPointerId(event), {
      pointerType,
      button: event.button,
      startX: round(event.clientX),
      startY: round(event.clientY),
      startMono: host.now(),
      maxDistance: 0,
      dragStarted: false,
      dnd: this.dnd !== null,
      target
    });
  }

  private onPointerUp(event: PointerEvent, cancelled: boolean): void {
    const { host } = this;
    const pointerId = readPointerId(event);
    const press = this.presses.get(pointerId);
    this.presses.delete(pointerId);

    if (cancelled && press?.dnd) {
      // The browser took the gesture over for drag-and-drop; dragend reports it.
      return;
    }

    host.markUserActivity();

    if (!cancelled) {
      host.trackPointer(event.clientX, event.clientY);
    }

    const holdMs = press ? Math.max(0, host.now() - press.startMono) : undefined;
    const distance = press
      ? Math.hypot(event.clientX - press.startX, event.clientY - press.startY)
      : undefined;
    // Only a primary-button hold is a long press; a held right button is a context menu.
    const longPress =
      press !== undefined &&
      holdMs !== undefined &&
      !cancelled &&
      press.button === 0 &&
      !press.dragStarted &&
      holdMs >= POINTER_LONG_PRESS_MS &&
      press.maxDistance < POINTER_DRAG_THRESHOLD_PX;

    host.emit("pointerup", {
      ...readPointerBase(event),
      pointerType: press?.pointerType ?? readPointerType(event),
      pointerId,
      button: event.button,
      buttons: event.buttons,
      ...readModifiers(event),
      ...(holdMs !== undefined ? { holdMs: round(holdMs) } : {}),
      ...(longPress ? { longPress: true } : {}),
      ...(distance !== undefined ? { distance: round(distance) } : {}),
      ...(cancelled ? { cancelled: true } : {}),
      target: host.targetPayload(event.target, "rich")
    });

    if (press?.dragStarted && !press.dnd) {
      this.emitPointerDragEnd(event, press, cancelled);
    }
  }

  private emitPointerDragEnd(event: PointerEvent, press: PressState, cancelled: boolean): void {
    const x = round(event.clientX);
    const y = round(event.clientY);
    const dropElement = elementAtPoint(x, y) ?? event.target;

    this.host.emit("dragEnd", {
      kind: "pointer",
      pointerType: press.pointerType,
      x,
      y,
      ...readGeometry(),
      startX: press.startX,
      startY: press.startY,
      dx: round(x - press.startX),
      dy: round(y - press.startY),
      distance: round(Math.hypot(x - press.startX, y - press.startY)),
      durationMs: round(Math.max(0, this.host.now() - press.startMono)),
      ...(cancelled ? { cancelled: true } : {}),
      target: { ...press.target },
      dropTarget: this.host.targetPayload(dropElement, "rich")
    });
  }

  private onAuxAction(rawType: "contextmenu" | "auxclick", event: MouseEvent): void {
    // A right click fires both; auxclick for button 2 adds nothing over contextmenu.
    if (rawType === "auxclick" && event.button === 2) {
      return;
    }

    this.host.markUserActivity();
    this.host.trackPointer(event.clientX, event.clientY);
    this.host.emit(rawType, {
      ...readPointerBase(event),
      button: event.button,
      ...readModifiers(event),
      target: this.host.targetPayload(event.target, "rich")
    });
  }

  private onWheel(event: WheelEvent): void {
    if (!this.host.options().wheel || (event.deltaX === 0 && event.deltaY === 0)) {
      return;
    }

    const now = this.host.now();
    const zoom = event.ctrlKey;
    const burst = this.wheelBurst;

    if (
      burst &&
      (burst.zoom !== zoom ||
        burst.deltaMode !== event.deltaMode ||
        burst.target !== event.target ||
        now - burst.startMono >= WHEEL_BURST_MAX_MS)
    ) {
      this.flushWheelBurst();
    }

    const current = this.wheelBurst ?? {
      startMono: now,
      lastMono: now,
      deltaX: 0,
      deltaY: 0,
      deltaMode: event.deltaMode,
      count: 0,
      zoom,
      x: round(event.clientX),
      y: round(event.clientY),
      modifiers: readModifiers(event),
      target: event.target
    };

    this.wheelBurst = {
      ...current,
      lastMono: now,
      deltaX: current.deltaX + event.deltaX,
      deltaY: current.deltaY + event.deltaY,
      count: current.count + 1
    };

    if (this.wheelTimer !== null) {
      clearTimeout(this.wheelTimer);
    }

    this.wheelTimer = setTimeout(() => {
      this.wheelTimer = null;
      this.flushWheelBurst();
    }, WHEEL_BURST_IDLE_MS);
  }

  private flushWheelBurst(): void {
    const burst = this.wheelBurst;
    this.wheelBurst = null;

    if (!burst || !this.host.isRecording()) {
      return;
    }

    this.host.emit(
      "wheel",
      {
        x: burst.x,
        y: burst.y,
        ...readGeometry(),
        ...burst.modifiers,
        deltaX: round(burst.deltaX),
        deltaY: round(burst.deltaY),
        deltaMode: burst.deltaMode,
        count: burst.count,
        durationMs: round(burst.lastMono - burst.startMono),
        zoom: burst.zoom,
        target: this.host.targetPayload(burst.target, "fast")
      },
      burst.startMono
    );
  }

  private onDragStart(event: DragEvent): void {
    for (const press of this.presses.values()) {
      press.dnd = true;
    }

    if (!this.host.options().drag) {
      this.dnd = null;
      return;
    }

    this.host.markUserActivity();
    const x = round(event.clientX);
    const y = round(event.clientY);
    this.dnd = { startX: x, startY: y, startMono: this.host.now() };
    this.host.emit("dragStart", {
      kind: "dnd",
      x,
      y,
      ...readGeometry(),
      target: this.host.targetPayload(event.target, "rich")
    });
  }

  private onDrop(event: DragEvent): void {
    if (!this.dnd) {
      return;
    }

    this.dnd = {
      ...this.dnd,
      dropTarget: this.host.targetPayload(event.target, "rich"),
      dropX: round(event.clientX),
      dropY: round(event.clientY)
    };
  }

  private onDragEnd(event: DragEvent): void {
    const dnd = this.dnd;
    this.dnd = null;

    if (!dnd || !this.host.options().drag) {
      return;
    }

    this.host.markUserActivity();
    const dropped = dnd.dropTarget !== undefined;
    const x = dnd.dropX ?? round(event.clientX);
    const y = dnd.dropY ?? round(event.clientY);
    const dropEffect = event.dataTransfer?.dropEffect;

    this.host.emit("dragEnd", {
      kind: "dnd",
      x,
      y,
      ...readGeometry(),
      startX: dnd.startX,
      startY: dnd.startY,
      dx: round(x - dnd.startX),
      dy: round(y - dnd.startY),
      distance: round(Math.hypot(x - dnd.startX, y - dnd.startY)),
      durationMs: round(Math.max(0, this.host.now() - dnd.startMono)),
      dropped,
      ...(typeof dropEffect === "string" && dropEffect.length > 0 ? { dropEffect } : {}),
      target: this.host.targetPayload(event.target, "rich"),
      ...(dnd.dropTarget ? { dropTarget: dnd.dropTarget } : {})
    });
  }

  private onSelectionChange(): void {
    if (!this.host.options().drag) {
      return;
    }

    if (this.selectionTimer !== null) {
      clearTimeout(this.selectionTimer);
    }

    this.selectionTimer = setTimeout(() => {
      this.selectionTimer = null;
      this.emitSelection();
    }, SELECTION_SETTLE_MS);
  }

  private emitSelection(): void {
    if (!this.host.isRecording() || !this.host.options().drag) {
      return;
    }

    const selection = readSelectionState(this.host.policy());

    if (!selection) {
      this.lastSelectionKey = "";
      return;
    }

    const key = `${selection.length}:${selection.editable}:${selection.anchorKey}`;

    if (key === this.lastSelectionKey) {
      return;
    }

    this.lastSelectionKey = key;
    this.host.emit("selection", {
      length: selection.length,
      ...(selection.text !== undefined ? { text: selection.text } : {}),
      ...(selection.editable ? { editable: true } : {}),
      target: this.host.targetPayload(selection.element, "rich")
    });
  }

  private onPointerOver(event: PointerEvent): void {
    if (!this.host.options().hover || readPointerType(event) === "touch") {
      if (this.hover) {
        this.hover = null;
      }

      return;
    }

    const element = resolveInteractiveElement(event.target);

    if (element === this.hover?.element) {
      return;
    }

    this.finishHover();

    if (element) {
      this.hover = {
        element,
        enterMono: this.host.now(),
        x: round(event.clientX),
        y: round(event.clientY)
      };
    }
  }

  private onPointerOut(event: PointerEvent): void {
    // Leaving the document: no element receives the next pointerover.
    if (event.relatedTarget === null) {
      this.finishHover();
    }
  }

  private finishHover(): void {
    const hover = this.hover;
    this.hover = null;

    if (!hover || !this.host.isRecording() || !this.host.options().hover) {
      return;
    }

    const dwellMs = this.host.now() - hover.enterMono;

    if (dwellMs < HOVER_DWELL_MIN_MS) {
      return;
    }

    this.host.emit(
      "hover",
      {
        x: hover.x,
        y: hover.y,
        ...readGeometry(),
        dwellMs: round(Math.min(dwellMs, HOVER_DWELL_MAX_MS)),
        target: this.host.targetPayload(hover.element, "rich")
      },
      hover.enterMono
    );
  }
}

type SelectionState = {
  length: number;
  text?: string;
  editable: boolean;
  element: Element | null;
  anchorKey: string;
};

function readSelectionState(policy: CapturePolicy): SelectionState | null {
  const active = document.activeElement;

  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    if (isPrivateField(active, policy)) {
      return null;
    }

    const length = readFieldSelectionLength(active);
    return length > 0
      ? { length, editable: true, element: active, anchorKey: `field:${active.tagName}` }
      : null;
  }

  const selection = typeof document.getSelection === "function" ? document.getSelection() : null;

  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const raw = selection.toString();

  if (raw.length === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const element = toElement(range.commonAncestorContainer);
  const editable =
    element instanceof HTMLElement &&
    (element.isContentEditable ||
      element.closest("[contenteditable='true'], [contenteditable='plaintext-only']") !== null);
  const textAllowed =
    !editable &&
    allowsSelectionText(policy) &&
    [toElement(selection.anchorNode), toElement(selection.focusNode)].every(
      (node) => node !== null && !isCoveredByBlockedSelector(node, policy.redaction)
    ) &&
    !rangeTouchesBlockedElement(range, policy.redaction.blockedSelectors);

  return {
    length: raw.length,
    ...(textAllowed ? { text: raw.slice(0, SELECTION_TEXT_MAX_CHARS) } : {}),
    editable,
    element,
    anchorKey: `${selection.anchorOffset}:${selection.focusOffset}`
  };
}

/** Never-captured (password-like) and blocked fields do not even report a selection length. */
function isPrivateField(
  field: HTMLInputElement | HTMLTextAreaElement,
  policy: CapturePolicy
): boolean {
  return isNeverCapturedField(field) || isCoveredByBlockedSelector(field, policy.redaction);
}

/**
 * True when the selected range covers any part of a blocked element, so selected text never
 * spans blocked content between clean endpoints. Invalid selectors fail closed.
 */
function rangeTouchesBlockedElement(range: Range, blockedSelectors: readonly string[]): boolean {
  for (const selector of blockedSelectors) {
    try {
      for (const element of Array.from(document.querySelectorAll(selector))) {
        if (range.intersectsNode(element)) {
          return true;
        }
      }
    } catch {
      return true;
    }
  }

  return false;
}

function readFieldSelectionLength(field: HTMLInputElement | HTMLTextAreaElement): number {
  try {
    const start = field.selectionStart;
    const end = field.selectionEnd;
    return typeof start === "number" && typeof end === "number" ? Math.max(0, end - start) : 0;
  } catch {
    // Inputs like `type="email"` throw on selection access.
    return 0;
  }
}

function toElement(node: Node | null): Element | null {
  if (!node) {
    return null;
  }

  return node instanceof Element ? node : node.parentElement;
}

function elementAtPoint(x: number, y: number): Element | null {
  if (typeof document.elementFromPoint !== "function") {
    return null;
  }

  try {
    return document.elementFromPoint(x, y);
  } catch {
    return null;
  }
}

function isOwnIndicatorMutation(record: MutationRecord): boolean {
  const element = toElement(record.target);
  return element !== null && element.closest(WEBBLACKBOX_INDICATOR_SELECTOR) !== null;
}

function readPointerBase(event: MouseEvent): Record<string, unknown> {
  return {
    x: round(event.clientX),
    y: round(event.clientY),
    pageX: round(event.pageX),
    pageY: round(event.pageY),
    ...readGeometry()
  };
}

/** Viewport and frame offset shared by every pointer action. */
export function readGeometry(): Record<string, unknown> {
  const viewport = readViewportGeometry();
  const frameOffset = readFrameOffset();

  return {
    ...(viewport ? { viewport } : {}),
    ...(frameOffset ? { frameOffset } : {})
  };
}

function readModifiers(event: MouseEvent): Record<string, boolean> {
  return {
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey
  };
}

function readPointerType(event: MouseEvent): PointerKind {
  const value = (event as Partial<PointerEvent>).pointerType;
  return value === "mouse" || value === "touch" || value === "pen"
    ? value
    : value === undefined || value === ""
      ? "mouse"
      : "unknown";
}

function readPointerId(event: MouseEvent): number {
  const value = (event as Partial<PointerEvent>).pointerId;
  return typeof value === "number" && Number.isFinite(value) ? value : 1;
}
