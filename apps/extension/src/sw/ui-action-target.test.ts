import { describe, expect, it, vi } from "vitest";

import { resolveUiActionTabId } from "./ui-action-target.js";

function sources(overrides: Partial<Parameters<typeof resolveUiActionTabId>[0]> = {}) {
  return {
    queryActiveTabId: vi.fn(async () => 7 as number | undefined),
    fallbackTabId: vi.fn(() => 9 as number | undefined),
    ...overrides
  };
}

describe("resolveUiActionTabId", () => {
  it("prefers the tab id the caller asked for", async () => {
    const input = sources({ requestedTabId: 3, senderTabId: 5 });

    await expect(resolveUiActionTabId(input)).resolves.toBe(3);
    expect(input.queryActiveTabId).not.toHaveBeenCalled();
  });

  it("targets the sender tab instead of the focused window's active tab", async () => {
    // An in-page caller's tab can sit in a window that is not focused (e.g. a tab opened
    // through DevTools while the initial about:blank window keeps focus).
    const input = sources({ senderTabId: 5 });

    await expect(resolveUiActionTabId(input)).resolves.toBe(5);
    expect(input.queryActiveTabId).not.toHaveBeenCalled();
  });

  it("falls back to the active tab for callers without a tab (popup, service worker)", async () => {
    await expect(resolveUiActionTabId(sources())).resolves.toBe(7);
  });

  it("falls back to a recording tab when no tab is active", async () => {
    const input = sources({ queryActiveTabId: vi.fn(async () => undefined) });

    await expect(resolveUiActionTabId(input)).resolves.toBe(9);
  });

  it("ignores non-numeric ids", async () => {
    const input = sources({
      requestedTabId: Number.NaN,
      senderTabId: undefined
    });

    await expect(resolveUiActionTabId(input)).resolves.toBe(7);
  });
});
