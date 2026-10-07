import { describe, expect, it, vi } from "vitest";

import { PORT_NAMES } from "../shared/messages.js";
import { createPortRegistry, logPortSendFailure } from "./port-registry.js";
import { createPortTrafficMeter } from "./port-traffic.js";

function createPort(name: string) {
  const port = {
    name,
    sent: [] as unknown[],
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onDisconnect: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    postMessage: vi.fn(),
    disconnect: vi.fn()
  };

  port.postMessage.mockImplementation((message: unknown) => {
    port.sent.push(message);
  });

  return port;
}

function createRegistry(scope: Record<string, unknown> = {}) {
  const traffic = createPortTrafficMeter(scope);
  const registry = createPortRegistry({
    offscreenPortTraffic: traffic,
    shouldLogPortDebug: () => false
  });

  return { registry, traffic };
}

describe("createPortRegistry", () => {
  it("broadcasts to every connected port the message kind is delivered to", () => {
    const { registry } = createRegistry();
    const popup = createPort(PORT_NAMES.popup);
    const content = createPort(PORT_NAMES.content);

    registry.addPort(popup);
    registry.addPort(content);
    registry.broadcast({ kind: "sw.session-list", sessions: [] });

    expect(popup.sent).toHaveLength(1);
    expect(content.sent).toHaveLength(1);
  });

  it("keeps recording-status broadcasts away from content and offscreen ports", () => {
    const { registry } = createRegistry();
    const popup = createPort(PORT_NAMES.popup);
    const content = createPort(PORT_NAMES.content);
    const offscreen = createPort(PORT_NAMES.offscreen);

    registry.addPort(popup);
    registry.addPort(content);
    registry.addPort(offscreen);
    registry.setOffscreenPort(offscreen);
    registry.broadcast({ kind: "sw.recording-status", active: false });

    expect(popup.sent).toHaveLength(1);
    expect(content.sent).toHaveLength(0);
    expect(offscreen.sent).toHaveLength(1);
  });

  it("delivers only recording-status broadcasts to the offscreen port", () => {
    const { registry } = createRegistry();
    const offscreen = createPort(PORT_NAMES.offscreen);

    registry.addPort(offscreen);
    registry.setOffscreenPort(offscreen);
    registry.broadcast({ kind: "sw.session-list", sessions: [] });

    expect(offscreen.sent).toHaveLength(0);
  });

  it("forgets a port whose send throws and clears its offscreen binding", () => {
    const { registry } = createRegistry();
    const offscreen = createPort(PORT_NAMES.offscreen);
    offscreen.postMessage.mockImplementation(() => {
      throw new Error("port is gone");
    });

    registry.addPort(offscreen);
    registry.setOffscreenPort(offscreen);
    registry.sendPortMessage(offscreen, { kind: "sw.session-list", sessions: [] });

    expect(registry.hasPort(offscreen)).toBe(false);
    expect(registry.getOffscreenPort()).toBeNull();

    registry.broadcast({ kind: "sw.recording-status", active: true, sid: "S-1" });
    expect(offscreen.sent).toHaveLength(0);
  });

  it("clears the offscreen binding only for the bound port", () => {
    const { registry } = createRegistry();
    const offscreen = createPort(PORT_NAMES.offscreen);
    const other = createPort(PORT_NAMES.popup);

    registry.setOffscreenPort(offscreen);
    expect(registry.clearOffscreenPort(other)).toBe(false);
    expect(registry.getOffscreenPort()).toBe(offscreen);
    expect(registry.clearOffscreenPort(offscreen)).toBe(true);
    expect(registry.getOffscreenPort()).toBeNull();
  });

  it("records traffic for messages sent on the offscreen port only", () => {
    const scope: Record<string, unknown> = { __WEBBLACKBOX_PORT_TRAFFIC__: true };
    const { registry, traffic } = createRegistry(scope);
    const offscreen = createPort(PORT_NAMES.offscreen);
    const popup = createPort(PORT_NAMES.popup);

    registry.addPort(offscreen);
    registry.addPort(popup);
    registry.setOffscreenPort(offscreen);
    registry.sendPortMessage(offscreen, { kind: "sw.recording-status", active: true, sid: "S-1" });
    registry.sendPortMessage(popup, { kind: "sw.session-list", sessions: [] });

    expect(traffic.snapshot().sent.messages).toBe(1);
  });
});

describe("logPortSendFailure", () => {
  it("stays silent unless port debugging is on", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);

    logPortSendFailure(() => false, "sw.session-list", new Error("boom"));
    expect(debug).not.toHaveBeenCalled();

    logPortSendFailure(() => true, "sw.session-list", new Error("boom"), { portName: "popup" });
    expect(debug).toHaveBeenCalledOnce();

    debug.mockRestore();
  });
});
