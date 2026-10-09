import { afterEach, describe, expect, it, vi } from "vitest";

import { createActionBadge, type BadgeSpec } from "./action-badge.js";

const UPDATE: BadgeSpec = { text: "↑", color: "#1667b8" };

function createHarness(
  options: { recording?: boolean; unread?: boolean; update?: BadgeSpec | null } = {}
) {
  const flags = {
    recording: options.recording ?? false,
    unread: options.unread ?? false,
    update: options.update === undefined ? UPDATE : options.update
  };
  const action = {
    setBadgeText: vi.fn<(details: { text: string }) => Promise<void>>(async () => undefined),
    setBadgeBackgroundColor: vi.fn<(details: { color: string }) => Promise<void>>(
      async () => undefined
    )
  };
  const badge = createActionBadge({
    action,
    isRecording: () => flags.recording,
    hasUnreadProfileNotice: () => flags.unread,
    idleNotice: async () => flags.update
  });
  const text = () => action.setBadgeText.mock.lastCall?.[0].text;

  return { badge, action, flags, text };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("action badge precedence", () => {
  it("REC beats the profile-change notice and the update notice", async () => {
    const harness = createHarness({ recording: true, unread: true });

    await harness.badge.refresh();

    expect(harness.text()).toBe("REC");
  });

  it("the unread profile-change notice beats the update notice", async () => {
    const harness = createHarness({ unread: true });

    await harness.badge.refresh();

    expect(harness.text()).toBe("!");
  });

  it("shows the update notice when nothing else claims the badge", async () => {
    const harness = createHarness();

    await harness.badge.refresh();

    expect(harness.text()).toBe("↑");
    expect(harness.action.setBadgeBackgroundColor).toHaveBeenLastCalledWith({
      color: UPDATE.color
    });
  });

  it("clears the badge when there is no notice, or the notice cannot be read", async () => {
    const none = createHarness({ update: null });
    await none.badge.setIdle();
    expect(none.text()).toBe("");

    const failing = createActionBadge({
      action: none.action,
      isRecording: () => false,
      hasUnreadProfileNotice: () => false,
      idleNotice: async () => {
        throw new Error("storage unavailable");
      }
    });
    await failing.setIdle();
    expect(none.text()).toBe("");
  });

  it("keeps the freeze highlight over a notice refresh, then falls back down the list", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ recording: true });

    await harness.badge.setFreeze();
    await harness.badge.refreshUnlessHighlighted();
    expect(harness.text()).toBe("ERR");

    harness.flags.recording = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(harness.text()).toBe("↑");

    await harness.badge.refreshUnlessHighlighted();
    expect(harness.text()).toBe("↑");
  });

  it("restores the unread profile-change notice after the freeze highlight", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ unread: true });

    await harness.badge.setFreeze();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(harness.text()).toBe("!");
  });

  it("does not overwrite REC or ERR set while the update notice was being read", async () => {
    for (const setNewer of ["setRecording", "setFreeze"] as const) {
      vi.useFakeTimers();
      let releaseRead: (badge: BadgeSpec | null) => void = () => undefined;
      const harness = createHarness();
      const badge = createActionBadge({
        action: harness.action,
        isRecording: () => false,
        hasUnreadProfileNotice: () => false,
        idleNotice: () =>
          new Promise<BadgeSpec | null>((resolve) => {
            releaseRead = resolve;
          })
      });

      const idle = badge.setIdle();
      await badge[setNewer]();
      releaseRead(UPDATE);
      await idle;

      expect(harness.text()).toBe(setNewer === "setRecording" ? "REC" : "ERR");
      vi.useRealTimers();
    }
  });

  it("applies the latest of two overlapping idle refreshes", async () => {
    const reads: Array<(badge: BadgeSpec | null) => void> = [];
    const harness = createHarness();
    const badge = createActionBadge({
      action: harness.action,
      isRecording: () => false,
      hasUnreadProfileNotice: () => false,
      idleNotice: () =>
        new Promise<BadgeSpec | null>((resolve) => {
          reads.push(resolve);
        })
    });

    const stale = badge.setIdle();
    const fresh = badge.setIdle();
    reads[1]?.(null);
    await fresh;
    reads[0]?.(UPDATE);
    await stale;

    expect(harness.action.setBadgeText).toHaveBeenCalledTimes(1);
    expect(harness.text()).toBe("");
  });

  it("survives a missing action API", async () => {
    const badge = createActionBadge({
      action: undefined,
      isRecording: () => false,
      hasUnreadProfileNotice: () => false
    });

    await expect(badge.refresh()).resolves.toBeUndefined();
  });
});
