import { describe, expect, it, vi } from "vitest";

import { createSessionNotifications, exportPagePath } from "./session-notifications.js";
import type { SessionRuntime } from "./session-registry.js";

function createHarness(options: { popupOpen?: boolean } = {}) {
  let clickListener: ((notificationId: string) => void) | undefined;
  const notifications = {
    create: vi.fn(async (id: string) => id),
    clear: vi.fn(async () => true),
    onClicked: {
      addListener: (callback: (notificationId: string) => void) => {
        clickListener = callback;
      }
    }
  };
  const openTab = vi.fn(async () => undefined);
  const controller = createSessionNotifications({
    notifications,
    getMessage: (key) => `text:${key}`,
    getURL: (path) => `chrome-extension://wb/${path}`,
    isPopupOpen: () => options.popupOpen ?? false,
    openTab
  });

  return { controller, notifications, openTab, click: (id: string) => clickListener?.(id) };
}

const runtime = { sid: "S-7" } as SessionRuntime;

describe("session notifications", () => {
  it("asks to export a stopped recording when the popup is closed, and opens its export", () => {
    const harness = createHarness();

    harness.controller.notifyExportPending(runtime);
    harness.click("webblackbox.export:S-7");

    expect(harness.notifications.create).toHaveBeenCalledWith("webblackbox.export:S-7", {
      type: "basic",
      iconUrl: "chrome-extension://wb/icon/128.png",
      title: "text:notifyExportTitle",
      message: "text:notifyExportMessage",
      priority: 2
    });
    expect(harness.openTab).toHaveBeenCalledWith(`chrome-extension://wb/${exportPagePath("S-7")}`);
    expect(exportPagePath("S-7")).toBe("sessions.html#export=S-7");
  });

  it("leaves the export to the open popup", () => {
    const harness = createHarness({ popupOpen: true });

    harness.controller.notifyExportPending(runtime);

    expect(harness.notifications.create).not.toHaveBeenCalled();
  });

  it("warns about a fallback to Light and clears both notices of a recording", () => {
    const harness = createHarness({ popupOpen: true });

    harness.controller.notifyCaptureFallback(runtime);
    harness.controller.clear("S-7");
    harness.click("webblackbox.fallback:S-7");

    expect(harness.notifications.create).toHaveBeenCalledWith(
      "webblackbox.fallback:S-7",
      expect.objectContaining({ title: "text:notifyFallbackTitle" })
    );
    expect(harness.notifications.clear).toHaveBeenCalledWith("webblackbox.export:S-7");
    expect(harness.notifications.clear).toHaveBeenCalledWith("webblackbox.fallback:S-7");
    expect(harness.openTab).not.toHaveBeenCalled();
  });
});
