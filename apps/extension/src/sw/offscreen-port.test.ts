import { describe, expect, it, vi } from "vitest";

import { createOffscreenPortConnector, type OffscreenPortConnectorDeps } from "./offscreen-port.js";

type FakePort = { id: string };

type Harness = {
  deps: OffscreenPortConnectorDeps<FakePort>;
  calls: string[];
  setPort(port: FakePort | null): void;
};

function createHarness(
  options: {
    hasDocument?: boolean;
    onCreate?: (harness: Harness) => void;
    onReconnect?: (harness: Harness) => void;
  } = {}
): Harness {
  let port: FakePort | null = null;
  let hasDocument = options.hasDocument ?? false;
  const calls: string[] = [];
  const harness: Harness = {
    calls,
    setPort(next) {
      port = next;
    },
    deps: {
      getPort: () => port,
      hasDocument: async () => {
        calls.push("hasDocument");
        return hasDocument;
      },
      createDocument: async () => {
        calls.push("createDocument");
        hasDocument = true;
        options.onCreate?.(harness);
      },
      closeDocument: async () => {
        calls.push("closeDocument");
        hasDocument = false;
      },
      requestReconnect: async () => {
        calls.push("requestReconnect");
        options.onReconnect?.(harness);
      },
      wait: async () => undefined
    }
  };

  return harness;
}

const OPTIONS = { portWaitMs: 100, pollMs: 25 };

describe("offscreen port connector", () => {
  it("returns the connected port without touching the document", async () => {
    const harness = createHarness();
    harness.setPort({ id: "live" });

    const connector = createOffscreenPortConnector(harness.deps, OPTIONS);

    await expect(connector.ensurePort()).resolves.toEqual({ id: "live" });
    expect(harness.calls).toEqual([]);
  });

  it("creates the offscreen document when none exists", async () => {
    const harness = createHarness({
      onCreate: (current) => current.setPort({ id: "fresh" })
    });

    const connector = createOffscreenPortConnector(harness.deps, OPTIONS);

    await expect(connector.ensurePort()).resolves.toEqual({ id: "fresh" });
    expect(harness.calls).toEqual(["hasDocument", "createDocument"]);
  });

  it("asks a surviving offscreen document to reconnect after a service worker restart", async () => {
    const harness = createHarness({
      hasDocument: true,
      onReconnect: (current) => current.setPort({ id: "reconnected" })
    });

    const connector = createOffscreenPortConnector(harness.deps, OPTIONS);

    await expect(connector.ensurePort()).resolves.toEqual({ id: "reconnected" });
    expect(harness.calls).toEqual(["hasDocument", "requestReconnect"]);
  });

  it("recreates an unresponsive offscreen document", async () => {
    const harness = createHarness({
      hasDocument: true,
      onCreate: (current) => current.setPort({ id: "recreated" })
    });

    const connector = createOffscreenPortConnector(harness.deps, OPTIONS);

    await expect(connector.ensurePort()).resolves.toEqual({ id: "recreated" });
    expect(harness.calls).toEqual([
      "hasDocument",
      "requestReconnect",
      "closeDocument",
      "createDocument"
    ]);
  });

  it("still recreates the document when the reconnect request throws", async () => {
    const harness = createHarness({
      hasDocument: true,
      onReconnect: () => {
        throw new Error("Receiving end does not exist.");
      },
      onCreate: (current) => current.setPort({ id: "recreated" })
    });

    const connector = createOffscreenPortConnector(harness.deps, OPTIONS);

    await expect(connector.ensurePort()).resolves.toEqual({ id: "recreated" });
  });

  it("fails with the unavailable error when no port ever connects", async () => {
    const harness = createHarness({ hasDocument: true });
    const connector = createOffscreenPortConnector(harness.deps, OPTIONS);

    await expect(connector.ensurePort()).rejects.toThrow("Offscreen pipeline is unavailable.");
  });

  it("shares one recovery attempt between concurrent callers", async () => {
    const harness = createHarness({
      hasDocument: true,
      onReconnect: (current) => current.setPort({ id: "shared" })
    });
    const requestReconnect = vi.spyOn(harness.deps, "requestReconnect");
    const connector = createOffscreenPortConnector(harness.deps, OPTIONS);

    const [first, second] = await Promise.all([connector.ensurePort(), connector.ensurePort()]);

    expect(first).toEqual({ id: "shared" });
    expect(second).toEqual({ id: "shared" });
    expect(requestReconnect).toHaveBeenCalledTimes(1);
  });

  it("polls for a late port within the configured budget", async () => {
    let polls = 0;
    const harness = createHarness();
    harness.deps.wait = async () => {
      polls += 1;

      if (polls === 2) {
        harness.setPort({ id: "late" });
      }
    };

    const connector = createOffscreenPortConnector(harness.deps, OPTIONS);

    await expect(connector.ensurePort()).resolves.toEqual({ id: "late" });
    expect(harness.calls).toEqual(["hasDocument", "createDocument"]);
  });
});
