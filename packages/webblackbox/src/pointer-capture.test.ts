/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@zumer/snapdom", () => ({ snapdom: { toBlob: vi.fn() } }));

import { DEFAULT_CAPTURE_POLICY, type CapturePolicy } from "@webblackbox/protocol";

import { LiteCaptureAgent } from "./lite-capture-agent.js";
import type { LiteCaptureState } from "./types.js";

type EmittedEvent = { rawType: string; mono: number; payload: Record<string, unknown> };

const READABLE_POLICY: CapturePolicy = {
  ...DEFAULT_CAPTURE_POLICY,
  categories: { ...DEFAULT_CAPTURE_POLICY.categories, actions: "allow", dom: "allow" }
};

const ALL_POINTER = { hover: true, drag: true, wheel: true };

function createAgent(state: Partial<LiteCaptureState> = {}) {
  const emitBatch = vi.fn();
  const agent = new LiteCaptureAgent({ emitBatch, showIndicator: false, frameScope: "top" });

  agent.setRecordingStatus({ active: true, sid: "S-pointer", tabId: 3, mode: "lite", ...state });
  agent.flush();
  emitBatch.mockClear();

  const events = (): EmittedEvent[] => {
    agent.flush();
    return emitBatch.mock.calls.flatMap((call) => call[0] as EmittedEvent[]);
  };
  const ofType = (rawType: string): EmittedEvent[] =>
    events().filter((event) => event.rawType === rawType);

  return { agent, emitBatch, events, ofType };
}

function pointer(
  type: string,
  target: EventTarget,
  init: MouseEventInit & { pointerType?: string; pointerId?: number } = {}
): void {
  const { pointerType = "mouse", pointerId = 1, ...mouseInit } = init;
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...mouseInit });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  target.dispatchEvent(event);
}

function dragEvent(type: string, target: EventTarget, clientX: number, clientY: number): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(event, "dataTransfer", { value: { dropEffect: "move" } });
  target.dispatchEvent(event);
}

function element<T extends Element = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);

  if (!found) {
    throw new Error(`missing ${selector}`);
  }

  return found;
}

describe("pointer capture", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <main>
        <button id="save" data-testid="save-button" aria-label="Save draft">Save</button>
        <button class="plain">Plain</button>
        <button class="plain">Plain</button>
        <p id="para">Quarterly revenue grew by twelve percent</p>
        <div data-sensitive><button id="secret-action">Reveal 4111</button></div>
        <div id="zone">Drop here</div>
        <input id="field" type="text" value="hello world" />
      </main>
    `;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("records presses with pointer type, button, hold time and long press", async () => {
    const { agent, ofType } = createAgent();
    const save = element("#save");

    pointer("pointerdown", save, { clientX: 10, clientY: 12, button: 0, pointerType: "touch" });
    await vi.advanceTimersByTimeAsync(650);
    pointer("pointerup", save, { clientX: 11, clientY: 12, button: 0, pointerType: "touch" });

    const [down] = ofType("pointerdown");
    const [up] = ofType("pointerup");

    expect(down?.payload).toMatchObject({ pointerType: "touch", button: 0, x: 10, y: 12 });
    expect(up?.payload).toMatchObject({ pointerType: "touch", longPress: true, distance: 1 });
    expect(up?.payload.holdMs).toBeGreaterThanOrEqual(600);

    pointer("pointerdown", save, { clientX: 10, clientY: 12 });
    await vi.advanceTimersByTimeAsync(80);
    pointer("pointerup", save, { clientX: 10, clientY: 12 });

    expect(ofType("pointerup")[1]?.payload).not.toHaveProperty("longPress");
    agent.dispose();
  });

  it("does not report a held right button as a long press", async () => {
    const { agent, ofType } = createAgent();
    const save = element("#save");

    pointer("pointerdown", save, { clientX: 10, clientY: 12, button: 2 });
    await vi.advanceTimersByTimeAsync(700);
    pointer("pointerup", save, { clientX: 10, clientY: 12, button: 2 });

    expect(ofType("pointerup")[0]?.payload.holdMs).toBeGreaterThanOrEqual(700);
    expect(ofType("pointerup")[0]?.payload).not.toHaveProperty("longPress");
    agent.dispose();
  });

  it("records right and middle clicks without duplicating the right-button auxclick", () => {
    const { agent, ofType } = createAgent();
    const save = element("#save");

    save.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, button: 2, clientX: 5, clientY: 6 })
    );
    save.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 2 }));
    save.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));

    expect(ofType("contextmenu")).toHaveLength(1);
    expect(ofType("contextmenu")[0]?.payload).toMatchObject({ button: 2, x: 5, y: 6 });
    expect(ofType("auxclick").map((event) => event.payload.button)).toEqual([1]);
    agent.dispose();
  });

  it("adds page coordinates, viewport geometry and the target rect to clicks", async () => {
    const { agent, ofType } = createAgent();

    element("#save").dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: 20, clientY: 30 })
    );
    // The rect is read right after the handlers ran, off the click hot path.
    await vi.advanceTimersByTimeAsync(0);

    const [click] = ofType("click");
    expect(click?.payload).toMatchObject({
      x: 20,
      y: 30,
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: 1, scrollX: 0, scrollY: 0 }
    });
    expect(click?.payload).toHaveProperty("pageX");
    expect(click?.payload.target).toMatchObject({ tag: "BUTTON", rect: { x: 0, y: 0 } });
    agent.dispose();
  });

  it("keeps targets hashed unless the profile allows readable actions", () => {
    const hashed = createAgent();
    element("#save").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const hashedTarget = hashed.ofType("click")[0]?.payload.target;

    expect(hashedTarget).not.toHaveProperty("readable");
    expect(JSON.stringify(hashedTarget)).not.toContain("Save");
    hashed.agent.dispose();

    const readable = createAgent({ capturePolicy: READABLE_POLICY });
    element("#save").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    element(".plain:nth-of-type(2)").dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const [saveClick, plainClick] = readable.ofType("click");
    expect(saveClick?.payload.target).toMatchObject({
      readable: {
        role: "button",
        ariaLabel: "Save draft",
        text: "Save",
        testId: "save-button",
        css: '[data-testid="save-button"]'
      }
    });
    expect(plainClick?.payload.target).toMatchObject({
      readable: { text: "Plain", css: "button:nth-of-type(2)" }
    });
    readable.agent.dispose();
  });

  it("never makes targets under a blocked selector readable", () => {
    const { agent, ofType } = createAgent({ capturePolicy: READABLE_POLICY });

    element("#secret-action").dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const target = ofType("click")[0]?.payload.target;
    expect(target).not.toHaveProperty("readable");
    expect(JSON.stringify(target)).not.toContain("4111");
    agent.dispose();
  });

  it("records pointer drags only when the profile enables drag capture", () => {
    const off = createAgent();
    const save = element("#save");

    pointer("pointerdown", save, { clientX: 10, clientY: 10, buttons: 1 });
    pointer("pointermove", document, { clientX: 60, clientY: 10, buttons: 1 });
    pointer("pointerup", save, { clientX: 60, clientY: 10 });
    expect(off.ofType("dragStart")).toHaveLength(0);
    off.agent.dispose();

    const on = createAgent({ pointer: ALL_POINTER });
    pointer("pointerdown", save, { clientX: 10, clientY: 10, buttons: 1 });
    pointer("pointermove", document, { clientX: 14, clientY: 10, buttons: 1 });
    pointer("pointermove", document, { clientX: 40, clientY: 10, buttons: 1 });
    pointer("pointermove", document, { clientX: 70, clientY: 10, buttons: 1 });
    pointer("pointerup", element("#zone"), { clientX: 70, clientY: 10 });

    expect(on.ofType("dragStart")).toHaveLength(1);
    expect(on.ofType("dragStart")[0]?.payload).toMatchObject({ kind: "pointer", x: 10, y: 10 });
    expect(on.ofType("dragEnd")[0]?.payload).toMatchObject({
      kind: "pointer",
      startX: 10,
      x: 70,
      dx: 60,
      distance: 60
    });
    expect(on.ofType("pointerup")[0]?.payload).not.toHaveProperty("longPress");
    on.agent.dispose();
  });

  it("records HTML5 drag-and-drop with the drop target", () => {
    const { agent, ofType } = createAgent({ pointer: ALL_POINTER, capturePolicy: READABLE_POLICY });
    const save = element("#save");
    const zone = element("#zone");

    pointer("pointerdown", save, { clientX: 10, clientY: 10 });
    dragEvent("dragstart", save, 12, 10);
    pointer("pointercancel", save, { clientX: 12, clientY: 10 });
    dragEvent("drop", zone, 200, 80);
    dragEvent("dragend", save, 0, 0);

    expect(ofType("dragStart")[0]?.payload).toMatchObject({ kind: "dnd", x: 12 });
    expect(ofType("dragEnd")[0]?.payload).toMatchObject({
      kind: "dnd",
      x: 200,
      y: 80,
      dropped: true,
      dropEffect: "move",
      dropTarget: { readable: { css: "#zone" } }
    });
    expect(ofType("pointerup")).toHaveLength(0);
    agent.dispose();
  });

  it("folds wheel bursts and separates Ctrl+wheel zoom", async () => {
    const off = createAgent();
    document.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
    await vi.advanceTimersByTimeAsync(200);
    expect(off.ofType("wheel")).toHaveLength(0);
    off.agent.dispose();

    const on = createAgent({ pointer: ALL_POINTER });
    for (const deltaY of [100, 100, 50]) {
      document.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY }));
      await vi.advanceTimersByTimeAsync(20);
    }
    document.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -30, ctrlKey: true }));
    await vi.advanceTimersByTimeAsync(200);

    const wheels = on.ofType("wheel");
    expect(wheels.map((event) => event.payload)).toMatchObject([
      { deltaY: 250, count: 3, zoom: false },
      { deltaY: -30, count: 1, zoom: true, ctrlKey: true }
    ]);
    on.agent.dispose();
  });

  it("records hover dwell over interactive elements only past the threshold", async () => {
    const { agent, ofType } = createAgent({ pointer: ALL_POINTER });
    const save = element("#save");
    const para = element("#para");

    pointer("pointerover", save, { clientX: 4, clientY: 4 });
    await vi.advanceTimersByTimeAsync(200);
    pointer("pointerover", para);
    expect(ofType("hover")).toHaveLength(0);

    pointer("pointerover", save, { clientX: 4, clientY: 4 });
    await vi.advanceTimersByTimeAsync(700);
    pointer("pointerover", para);

    const [hover] = ofType("hover");
    expect(hover?.payload).toMatchObject({ x: 4, y: 4 });
    expect(hover?.payload.dwellMs).toBeGreaterThanOrEqual(700);
    agent.dispose();
  });

  it("captures selection length always and its text only when the profile allows it", async () => {
    const select = () => {
      const range = document.createRange();
      range.selectNodeContents(element("#para"));
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    };

    const metadata = createAgent({ pointer: ALL_POINTER });
    select();
    await vi.advanceTimersByTimeAsync(400);
    expect(metadata.ofType("selection")[0]?.payload).toMatchObject({ length: 40 });
    expect(metadata.ofType("selection")[0]?.payload).not.toHaveProperty("text");
    metadata.agent.dispose();

    const readable = createAgent({ pointer: ALL_POINTER, capturePolicy: READABLE_POLICY });
    document.getSelection()?.removeAllRanges();
    select();
    await vi.advanceTimersByTimeAsync(400);
    expect(readable.ofType("selection")[0]?.payload).toMatchObject({
      length: 40,
      text: "Quarterly revenue grew by twelve percent"
    });
    readable.agent.dispose();
  });

  it("masks selected text with the profile's dom patterns", async () => {
    const policy: CapturePolicy = {
      ...READABLE_POLICY,
      redaction: {
        ...READABLE_POLICY.redaction,
        valuePatterns: [{ pattern: "twelve", targets: ["dom"] }]
      }
    };
    const { agent, ofType } = createAgent({ pointer: ALL_POINTER, capturePolicy: policy });
    const range = document.createRange();
    range.selectNodeContents(element("#para"));
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.advanceTimersByTimeAsync(400);

    expect(ofType("selection")[0]?.payload).toMatchObject({
      length: 40,
      text: "Quarterly revenue grew by [REDACTED] percent"
    });
    agent.dispose();
  });

  it("drops selected text that spans a blocked element between clean endpoints", async () => {
    const { agent, ofType } = createAgent({ pointer: ALL_POINTER, capturePolicy: READABLE_POLICY });
    const range = document.createRange();
    range.setStartBefore(element("#para"));
    range.setEndAfter(element("#zone"));
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.advanceTimersByTimeAsync(400);

    const [selection] = ofType("selection");
    expect(selection?.payload.length).toBeGreaterThan(0);
    expect(selection?.payload).not.toHaveProperty("text");
    agent.dispose();
  });

  it.each([
    `<input id="private" type="password" value="hunter2hunter2" />`,
    `<input id="private" type="text" autocomplete="one-time-code" value="123456789" />`,
    `<input id="private" type="text" name="new-password" value="hunter2hunter2" />`
  ])("reports no selection inside a never-captured field: %s", async (html) => {
    document.body.insertAdjacentHTML("beforeend", html);
    const { agent, ofType } = createAgent({ pointer: ALL_POINTER, capturePolicy: READABLE_POLICY });
    const field = element<HTMLInputElement>("#private");

    field.focus();
    field.setSelectionRange(0, 5);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.advanceTimersByTimeAsync(400);

    expect(ofType("selection")).toHaveLength(0);
    agent.dispose();
  });

  it("never captures text selected inside a field", async () => {
    const { agent, ofType } = createAgent({ pointer: ALL_POINTER, capturePolicy: READABLE_POLICY });
    const field = element<HTMLInputElement>("#field");

    field.focus();
    field.setSelectionRange(0, 5);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.advanceTimersByTimeAsync(400);

    expect(ofType("selection")[0]?.payload).toMatchObject({ length: 5, editable: true });
    expect(ofType("selection")[0]?.payload).not.toHaveProperty("text");
    agent.dispose();
  });

  it("reports whether a click caused a DOM reaction", async () => {
    const { agent, ofType } = createAgent();
    const save = element("#save");

    save.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const [click] = ofType("click");
    save.setAttribute("aria-pressed", "true");
    await vi.advanceTimersByTimeAsync(0);

    expect(ofType("clickReaction")[0]?.payload).toMatchObject({
      clickMono: click?.mono,
      mutated: true,
      windowMs: 1000
    });

    element("#para").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(ofType("clickReaction")[1]?.payload).toMatchObject({ mutated: false });
    agent.dispose();
  });

  it("samples mousemove in full mode at the profile rate", async () => {
    const { agent, ofType } = createAgent({ mode: "full", sampling: { mousemoveHz: 10 } });

    for (let step = 0; step < 10; step += 1) {
      pointer("pointermove", document, { clientX: step, clientY: step });
      await vi.advanceTimersByTimeAsync(50);
    }

    const moves = ofType("mousemove");
    expect(moves.length).toBeGreaterThanOrEqual(4);
    expect(moves.length).toBeLessThanOrEqual(6);
    agent.dispose();
  });

  it("ignores malformed pointer options", () => {
    const { agent, ofType } = createAgent({
      pointer: { drag: "yes", wheel: 1 } as unknown as LiteCaptureState["pointer"]
    });
    const save = element("#save");

    pointer("pointerdown", save, { clientX: 0, clientY: 0, buttons: 1 });
    pointer("pointermove", document, { clientX: 90, clientY: 0, buttons: 1 });
    pointer("pointerup", save, { clientX: 90, clientY: 0 });

    expect(ofType("dragStart")).toHaveLength(0);
    agent.dispose();
  });
});
