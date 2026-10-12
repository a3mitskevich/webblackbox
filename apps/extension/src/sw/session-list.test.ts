import { describe, expect, it, vi } from "vitest";

import { createSessionListView, toSessionMetadata } from "./session-list.js";
import { createSessionRegistry } from "./session-registry.js";
import { createRuntime } from "./stopped-session-lifecycle-harness.js";

const INTERRUPTION = {
  reason: "service-worker-restart" as const,
  detectedAt: 9_000,
  lastSeenAt: 8_000
};

describe("session list", () => {
  it("marks an interrupted recording in the list and in its pipeline metadata", () => {
    const registry = createSessionRegistry();
    const interrupted = createRuntime({
      sid: "S-interrupted",
      stoppedAt: 8_000,
      interruption: INTERRUPTION
    });
    const stopped = createRuntime({ sid: "S-stopped", tabId: 8, stoppedAt: 3_000 });
    registry.registerBySid(interrupted);
    registry.registerBySid(stopped);
    const broadcast = vi.fn();

    const { sessions } = createSessionListView({
      sessionRegistry: registry,
      broadcast
    }).buildSessionListMessage();

    expect(sessions.find((item) => item.sid === "S-interrupted")?.interruption).toEqual(
      INTERRUPTION
    );
    expect(sessions.find((item) => item.sid === "S-stopped")).not.toHaveProperty("interruption");
    expect(toSessionMetadata(interrupted).interruption).toEqual(INTERRUPTION);
    expect(toSessionMetadata(stopped)).not.toHaveProperty("interruption");
  });
});
