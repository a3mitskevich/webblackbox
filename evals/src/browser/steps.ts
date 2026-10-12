// Runs scenario steps on a page over CDP the way a tester would: real mouse events at the
// element's centre (so a covering element receives the click), text typed into the focused field.

import type { CdpClient } from "../../../apps/extension/scripts/lib/profile-e2e-harness.mjs";
import { sleep, waitFor } from "../../../apps/extension/scripts/lib/profile-e2e-harness.mjs";
import type { ScenarioStep } from "../types.js";

const NAVIGATION_TIMEOUT_MS = 15_000;
/** Lets the recorder attach to a freshly loaded document before the next step. */
const AFTER_NAVIGATION_SETTLE_MS = 1_200;
const BETWEEN_STEPS_MS = 250;

type Point = { x: number; y: number };

export async function runSteps(
  page: CdpClient,
  origin: string,
  steps: readonly ScenarioStep[]
): Promise<void> {
  for (const step of steps) {
    await runStep(page, origin, step);
    await sleep(BETWEEN_STEPS_MS);
  }
}

async function runStep(page: CdpClient, origin: string, step: ScenarioStep): Promise<void> {
  switch (step.kind) {
    case "navigate":
      await navigate(page, `${origin}${step.path}`);
      return;
    case "click":
      await click(page, step.selector, step.frame, step.clickCount ?? 1);
      return;
    case "type":
      await type(page, step.selector, step.text, step.frame);
      return;
    case "wait":
      await sleep(step.ms);
      return;
    case "waitFor":
      await waitFor(
        async () => ((await page.evaluate(`Boolean(${step.expression})`)) ? true : null),
        step.timeoutMs,
        `Condition not met: ${step.expression}`
      );
      return;
    case "evaluate":
      await page.evaluate(`(() => { ${step.expression}; return true; })()`);
      return;
  }
}

async function navigate(page: CdpClient, url: string): Promise<void> {
  await page.send("Page.navigate", { url });
  await waitFor(
    async () => ((await page.evaluate(`document.readyState === "complete"`)) ? true : null),
    NAVIGATION_TIMEOUT_MS,
    `Navigation to ${url} did not finish`
  );
  await sleep(AFTER_NAVIGATION_SETTLE_MS);
}

async function click(
  page: CdpClient,
  selector: string,
  frame: string | undefined,
  clickCount: number
): Promise<void> {
  const { x, y } = await elementCentre(page, selector, frame);

  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });

  for (let count = 1; count <= clickCount; count += 1) {
    const base = { x, y, button: "left", clickCount: count };
    await page.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed", buttons: 1 });
    await page.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased", buttons: 0 });
  }
}

/** Focuses the field without clicking (keeps a selection made by an earlier step) and types. */
async function type(
  page: CdpClient,
  selector: string,
  text: string,
  frame: string | undefined
): Promise<void> {
  await page.evaluate(`(() => {
    const element = ${elementLookup(selector, frame)};
    if (!element) throw new Error("Element not found: " + ${JSON.stringify(selector)});
    element.focus();
    return true;
  })()`);
  await page.send("Input.insertText", { text });
}

async function elementCentre(
  page: CdpClient,
  selector: string,
  frame: string | undefined
): Promise<Point> {
  const frameElement = frame ? `document.querySelector(${JSON.stringify(frame)})` : "null";
  const point = await page.evaluate(`(() => {
    const element = ${elementLookup(selector, frame)};
    if (!element) return null;
    element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    const frameElement = ${frameElement};
    const frameRect = frameElement ? frameElement.getBoundingClientRect() : { left: 0, top: 0 };
    const border = frameElement ? frameElement.clientLeft : 0;
    return {
      x: frameRect.left + border + rect.left + rect.width / 2,
      y: frameRect.top + border + rect.top + rect.height / 2
    };
  })()`);

  if (!isPoint(point)) {
    throw new Error(`Element not found: ${frame ? `${frame} → ` : ""}${selector}`);
  }

  return point;
}

function elementLookup(selector: string, frame: string | undefined): string {
  const root = frame
    ? `document.querySelector(${JSON.stringify(frame)})?.contentDocument`
    : "document";

  return `${root}?.querySelector(${JSON.stringify(selector)})`;
}

function isPoint(value: unknown): value is Point {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Point).x === "number" &&
    typeof (value as Point).y === "number"
  );
}
