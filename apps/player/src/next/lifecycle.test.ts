/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";

import { bindPageLifecycle } from "./index.js";

function pageHide(persisted: boolean): Event {
  const event = new Event("pagehide");
  Object.defineProperty(event, "persisted", { value: persisted });
  return event;
}

describe("bindPageLifecycle", () => {
  it("only pauses a page that goes into the back/forward cache", () => {
    const target = new EventTarget();
    const controller = { pause: vi.fn(), dispose: vi.fn() };
    bindPageLifecycle(target, controller);

    target.dispatchEvent(pageHide(true));
    expect(controller.pause).toHaveBeenCalledTimes(1);
    expect(controller.dispose).not.toHaveBeenCalled();

    target.dispatchEvent(pageHide(false));
    expect(controller.dispose).toHaveBeenCalledTimes(1);
  });
});
