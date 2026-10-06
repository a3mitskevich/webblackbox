import { describe, expect, it } from "vitest";

import { createCdpRouter } from "./router.js";
import type {
  CdpDetachHandler,
  CdpEventHandler,
  Debuggee,
  DebuggerRoot,
  DebuggerTransport,
  RawCdpEvent
} from "./types.js";

class FakeDebuggerTransport implements DebuggerTransport {
  public readonly attached: Array<{ debuggee: DebuggerRoot; version: string }> = [];

  public readonly detached: DebuggerRoot[] = [];

  public readonly commands: Array<{
    debuggee: Debuggee;
    method: string;
    params?: Record<string, unknown>;
  }> = [];

  private readonly eventListeners = new Set<CdpEventHandler>();

  private readonly detachListeners = new Set<CdpDetachHandler>();

  public async attach(debuggee: DebuggerRoot, version: string): Promise<void> {
    this.attached.push({ debuggee, version });
  }

  public async detach(debuggee: DebuggerRoot): Promise<void> {
    this.detached.push(debuggee);
  }

  public async sendCommand<TResult = unknown>(
    debuggee: Debuggee,
    method: string,
    params?: Record<string, unknown>
  ): Promise<TResult> {
    this.commands.push({ debuggee, method, params });
    return undefined as TResult;
  }

  public addEventListener(handler: CdpEventHandler): () => void {
    this.eventListeners.add(handler);

    return () => {
      this.eventListeners.delete(handler);
    };
  }

  public addDetachListener(handler: CdpDetachHandler): () => void {
    this.detachListeners.add(handler);

    return () => {
      this.detachListeners.delete(handler);
    };
  }

  public emitEvent(event: RawCdpEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  public emitDetach(tabId: number, reason: string): void {
    for (const listener of this.detachListeners) {
      listener({ tabId, reason });
    }
  }
}

describe("cdp-router", () => {
  it("attaches and enables baseline domains", async () => {
    const transport = new FakeDebuggerTransport();
    const router = createCdpRouter(transport);

    await router.attach(5);
    await router.enableBaseline(5);

    expect(transport.attached).toEqual([{ debuggee: { tabId: 5 }, version: "1.3" }]);
    expect(transport.commands.map((item) => item.method)).toEqual([
      "Network.enable",
      "Runtime.enable",
      "Log.enable",
      "Page.enable"
    ]);
  });

  it("enables auto attach using default flatten session settings", async () => {
    const transport = new FakeDebuggerTransport();
    const router = createCdpRouter(transport);

    await router.enableAutoAttach(7);

    const call = transport.commands[0];
    expect(call?.method).toBe("Target.setAutoAttach");
    expect(call?.params).toMatchObject({
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    });
  });

  it("tracks child sessions from attached and detached events", async () => {
    const transport = new FakeDebuggerTransport();
    const router = createCdpRouter(transport);
    await router.attach(9);

    transport.emitEvent({
      tabId: 9,
      method: "Target.attachedToTarget",
      params: {
        sessionId: "CHILD-1",
        targetInfo: { targetId: "TARGET-1", type: "iframe", url: "https://example.com/frame" }
      }
    });

    const attached = router.getAttachedTargets(9);
    expect(attached).toHaveLength(1);
    expect(attached[0]?.sessionId).toBe("CHILD-1");

    transport.emitEvent({
      tabId: 9,
      method: "Target.detachedFromTarget",
      params: {
        sessionId: "CHILD-1"
      }
    });

    expect(router.getAttachedTargets(9)).toHaveLength(0);
  });

  it("forwards detach events to listeners", async () => {
    const transport = new FakeDebuggerTransport();
    const router = createCdpRouter(transport);
    await router.attach(2);
    let reason = "";

    const unsubscribe = router.onDetach((event) => {
      reason = event.reason;
    });

    transport.emitDetach(2, "target_closed");
    unsubscribe();

    expect(reason).toBe("target_closed");
  });
  // chrome.debugger.onEvent is global to the extension: every router sees every attached tab.
  describe("tab isolation", () => {
    function collectEvents(router: ReturnType<typeof createCdpRouter>): RawCdpEvent[] {
      const events: RawCdpEvent[] = [];
      router.onEvent((event) => {
        events.push(event);
      });
      return events;
    }

    it("routes only the events of tabs the router attached, child sessions included", async () => {
      const transport = new FakeDebuggerTransport();
      const first = createCdpRouter(transport);
      const second = createCdpRouter(transport);
      const firstEvents = collectEvents(first);
      const secondEvents = collectEvents(second);

      await first.attach(1);
      await second.attach(2);

      transport.emitEvent({ tabId: 1, method: "Network.requestWillBeSent", params: {} });
      transport.emitEvent({
        tabId: 1,
        sessionId: "CHILD-OF-1",
        method: "Runtime.consoleAPICalled",
        params: {}
      });
      transport.emitEvent({ tabId: 2, method: "Network.requestWillBeSent", params: {} });
      transport.emitEvent({ tabId: 3, method: "Network.requestWillBeSent", params: {} });

      expect(firstEvents.map((event) => [event.tabId, event.sessionId])).toEqual([
        [1, undefined],
        [1, "CHILD-OF-1"]
      ]);
      expect(secondEvents.map((event) => [event.tabId, event.sessionId])).toEqual([[2, undefined]]);
    });

    it("does not track child targets of foreign tabs", async () => {
      const transport = new FakeDebuggerTransport();
      const router = createCdpRouter(transport);
      await router.attach(1);

      transport.emitEvent({
        tabId: 2,
        method: "Target.attachedToTarget",
        params: { sessionId: "CHILD-OF-2", targetInfo: { targetId: "T-2", type: "iframe" } }
      });
      transport.emitEvent({
        tabId: 1,
        method: "Target.attachedToTarget",
        params: { sessionId: "CHILD-OF-1", targetInfo: { targetId: "T-1", type: "worker" } }
      });

      expect(router.getAttachedTargets(2)).toEqual([]);
      expect(router.getAttachedTargets(1).map((target) => target.sessionId)).toEqual([
        "CHILD-OF-1"
      ]);
    });

    it("forwards only detaches of its own tabs", async () => {
      const transport = new FakeDebuggerTransport();
      const router = createCdpRouter(transport);
      const detached: number[] = [];
      router.onDetach((event) => {
        detached.push(event.tabId);
      });
      await router.attach(1);

      transport.emitDetach(2, "target_closed");
      transport.emitDetach(1, "target_closed");

      expect(detached).toEqual([1]);
    });

    it("stops routing a tab once it is detached", async () => {
      const transport = new FakeDebuggerTransport();
      const router = createCdpRouter(transport);
      const events = collectEvents(router);
      await router.attach(1);
      await router.attach(2);

      await router.detach(1);
      transport.emitDetach(2, "canceled_by_user");
      transport.emitEvent({ tabId: 1, method: "Network.requestWillBeSent", params: {} });
      transport.emitEvent({ tabId: 2, method: "Network.requestWillBeSent", params: {} });

      expect(events).toEqual([]);
    });
  });
});
