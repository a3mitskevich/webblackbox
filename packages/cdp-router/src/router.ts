import type {
  AutoAttachOptions,
  CdpDetachHandler,
  CdpEventHandler,
  Debuggee,
  DebuggerChild,
  DebuggerRoot,
  DebuggerTransport,
  RawCdpEvent,
  RouterAttachedTarget
} from "./types.js";

const BASELINE_DOMAINS = ["Network.enable", "Runtime.enable", "Log.enable", "Page.enable"] as const;

/**
 * `Network.enable` buffer sizes. Chrome keeps response bodies for `Network.getResponseBody` in a
 * per-session buffer (about 200 MB in total and 10 MB per resource by default) and evicts the
 * oldest bodies past it.
 */
export type NetworkEnableParams = {
  maxTotalBufferSize?: number;
  maxResourceBufferSize?: number;
  /** Longest request body inlined in `Network.requestWillBeSent`. */
  maxPostDataSize?: number;
};

export type BaselineDomainOptions = {
  network?: NetworkEnableParams;
};

const DEFAULT_AUTO_ATTACH_OPTIONS: AutoAttachOptions = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [
    { type: "iframe", exclude: false },
    { type: "worker", exclude: false },
    { type: "service_worker", exclude: false }
  ]
};

export interface CdpRouter {
  attach(tabId: number, protocolVersion?: "1.3" | "1.2"): Promise<void>;
  detach(tabId: number): Promise<void>;
  send<TResult = unknown>(
    target: Debuggee,
    method: string,
    params?: Record<string, unknown>
  ): Promise<TResult>;
  enableBaseline(tabId: number, sessionId?: string, options?: BaselineDomainOptions): Promise<void>;
  enableAutoAttach(
    tabId: number,
    options?: Partial<AutoAttachOptions>,
    sessionId?: string
  ): Promise<void>;
  getAttachedTargets(tabId: number): RouterAttachedTarget[];
  onEvent(callback: CdpEventHandler): () => void;
  onDetach(callback: CdpDetachHandler): () => void;
  dispose(): void;
}

type SessionMap = Map<string, RouterAttachedTarget>;

export class DefaultCdpRouter implements CdpRouter {
  private readonly eventListeners = new Set<CdpEventHandler>();

  private readonly detachListeners = new Set<CdpDetachHandler>();

  private readonly sessionsByTab = new Map<number, SessionMap>();

  private readonly transportUnsubscribe: Array<() => void>;

  public constructor(private readonly transport: DebuggerTransport) {
    // The transport delivers events of every tab the extension debugs (chrome.debugger.onEvent is
    // global), so a router only routes the tabs it attached itself. Child sessions (iframes,
    // workers) arrive with their root tab's id and stay with that tab.
    this.transportUnsubscribe = [
      this.transport.addEventListener((event) => {
        if (!this.sessionsByTab.has(event.tabId)) {
          return;
        }

        this.trackAttachedTargets(event);

        for (const listener of this.eventListeners) {
          listener(event);
        }
      }),
      this.transport.addDetachListener((event) => {
        if (!this.sessionsByTab.delete(event.tabId)) {
          return;
        }

        for (const listener of this.detachListeners) {
          listener(event);
        }
      })
    ];
  }

  public async attach(tabId: number, protocolVersion: "1.3" | "1.2" = "1.3"): Promise<void> {
    await this.transport.attach({ tabId }, protocolVersion);
    this.ensureSessionMap(tabId);
  }

  public async detach(tabId: number): Promise<void> {
    await this.transport.detach({ tabId });
    this.sessionsByTab.delete(tabId);
  }

  public async send<TResult = unknown>(
    target: Debuggee,
    method: string,
    params?: Record<string, unknown>
  ): Promise<TResult> {
    return this.transport.sendCommand<TResult>(target, method, params);
  }

  public async enableBaseline(
    tabId: number,
    sessionId?: string,
    options: BaselineDomainOptions = {}
  ): Promise<void> {
    const target: DebuggerRoot | DebuggerChild = sessionId ? { tabId, sessionId } : { tabId };

    for (const method of BASELINE_DOMAINS) {
      const params = method === "Network.enable" ? withoutUndefined(options.network) : undefined;
      await this.send(target, method, params);
    }
  }

  public async enableAutoAttach(
    tabId: number,
    options: Partial<AutoAttachOptions> = {},
    sessionId?: string
  ): Promise<void> {
    const params: AutoAttachOptions = {
      ...DEFAULT_AUTO_ATTACH_OPTIONS,
      ...options
    };

    const target: DebuggerRoot | DebuggerChild = sessionId ? { tabId, sessionId } : { tabId };

    await this.send(target, "Target.setAutoAttach", params as unknown as Record<string, unknown>);
  }

  public getAttachedTargets(tabId: number): RouterAttachedTarget[] {
    const sessions = this.sessionsByTab.get(tabId);

    if (!sessions) {
      return [];
    }

    return [...sessions.values()];
  }

  public onEvent(callback: CdpEventHandler): () => void {
    this.eventListeners.add(callback);

    return () => {
      this.eventListeners.delete(callback);
    };
  }

  public onDetach(callback: CdpDetachHandler): () => void {
    this.detachListeners.add(callback);

    return () => {
      this.detachListeners.delete(callback);
    };
  }

  public dispose(): void {
    for (const unsubscribe of this.transportUnsubscribe) {
      unsubscribe();
    }

    this.eventListeners.clear();
    this.detachListeners.clear();
    this.sessionsByTab.clear();
  }

  private ensureSessionMap(tabId: number): SessionMap {
    const existing = this.sessionsByTab.get(tabId);

    if (existing) {
      return existing;
    }

    const next = new Map<string, RouterAttachedTarget>();
    this.sessionsByTab.set(tabId, next);
    return next;
  }

  private trackAttachedTargets(event: RawCdpEvent): void {
    if (event.method === "Target.attachedToTarget") {
      const params = event.params as {
        sessionId?: string;
        targetInfo?: {
          targetId?: string;
          type?: string;
          url?: string;
        };
      };

      const childSessionId = params.sessionId;

      if (!childSessionId) {
        return;
      }

      const sessions = this.ensureSessionMap(event.tabId);
      sessions.set(childSessionId, {
        tabId: event.tabId,
        sessionId: childSessionId,
        targetId: params.targetInfo?.targetId,
        targetType: params.targetInfo?.type,
        url: params.targetInfo?.url
      });
      return;
    }

    if (event.method === "Target.detachedFromTarget") {
      const params = event.params as {
        sessionId?: string;
      };

      if (!params.sessionId) {
        return;
      }

      const sessions = this.sessionsByTab.get(event.tabId);
      sessions?.delete(params.sessionId);
    }
  }
}

/** The defined fields, or undefined when none are: a bare `Network.enable` keeps Chrome's defaults. */
function withoutUndefined(
  params: NetworkEnableParams | undefined
): Record<string, unknown> | undefined {
  const entries = Object.entries(params ?? {}).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function createCdpRouter(transport: DebuggerTransport): CdpRouter {
  return new DefaultCdpRouter(transport);
}
