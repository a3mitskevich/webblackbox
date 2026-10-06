export const DEFAULT_CDP_COMMAND_TIMEOUT_MS = 60_000;
export const DEFAULT_CDP_CONNECT_TIMEOUT_MS = 15_000;
const CDP_EXPRESSION_PREVIEW_CHARS = 160;

/**
 * Minimal Chrome DevTools Protocol client over a DevTools WebSocket URL.
 *
 * Every command is bounded by a timeout (per client, overridable per call) and the socket
 * connect is bounded as well, so a wedged target fails the run with an explicit message
 * instead of hanging it. Supports flat target sessions via `attachToTarget`.
 */
export class CdpClient {
  constructor(wsUrl, options = {}) {
    this.wsUrl = wsUrl;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_CDP_COMMAND_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CDP_CONNECT_TIMEOUT_MS;
    this.socket = null;
    this.sequence = 0;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.sessionEventHandlers = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl);
      this.socket = socket;

      const connectTimer = setTimeout(() => {
        reject(
          new Error(`Timed out after ${this.connectTimeoutMs}ms opening WebSocket: ${this.wsUrl}`)
        );
        socket.close();
      }, this.connectTimeoutMs);

      socket.addEventListener("open", () => {
        clearTimeout(connectTimer);
        resolve();
      });

      socket.addEventListener("error", () => {
        clearTimeout(connectTimer);
        reject(new Error(`Failed to open WebSocket: ${this.wsUrl}`));
      });

      socket.addEventListener("close", () => {
        clearTimeout(connectTimer);
        this.rejectAllPending("CDP socket closed");
      });

      socket.addEventListener("message", (event) => {
        this.handleMessage(event.data);
      });
    });
  }

  handleMessage(data) {
    let payload;

    try {
      payload = JSON.parse(String(data));
    } catch {
      return;
    }

    if (typeof payload.id === "number") {
      const pending = this.pending.get(payload.id);

      if (!pending) {
        return;
      }

      this.pending.delete(payload.id);
      clearTimeout(pending.timer);

      if (payload.error) {
        pending.reject(new Error(payload.error.message ?? JSON.stringify(payload.error)));
        return;
      }

      pending.resolve(payload.result);
      return;
    }

    if (typeof payload.method !== "string") {
      return;
    }

    const params = payload.params ?? {};

    for (const handler of this.eventHandlers.get(payload.method) ?? []) {
      handler(params);
    }

    if (typeof payload.sessionId === "string") {
      const key = `${payload.sessionId}:${payload.method}`;

      for (const handler of this.sessionEventHandlers.get(key) ?? []) {
        handler(params);
      }
    }
  }

  on(method, handler, sessionId) {
    const key = sessionId ? `${sessionId}:${method}` : method;
    const source = sessionId ? this.sessionEventHandlers : this.eventHandlers;
    source.set(key, [...(source.get(key) ?? []), handler]);
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {{ sessionId?: string, timeoutMs?: number }} [options]
   */
  send(method, params = {}, options = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP socket is not open (${method})`));
    }

    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs;
    const id = ++this.sequence;
    const message = JSON.stringify({
      id,
      method,
      params,
      ...(options.sessionId ? { sessionId: options.sessionId } : {})
    });

    // Created here so its stack names the caller; a timer callback has no useful stack.
    const timeoutError = new Error(
      `CDP command timed out after ${timeoutMs}ms: ${describeCdpCommand(method, params)}`
    );

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(timeoutError);
      }, timeoutMs);

      this.pending.set(id, { method, resolve, reject, timer });

      try {
        this.socket.send(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /**
   * Evaluates `expression` with `awaitPromise` and returns the value by value.
   * `options.sessionId` / `options.timeoutMs` route the command; any other option
   * (e.g. `contextId`) is forwarded to `Runtime.evaluate`.
   */
  async evaluate(expression, options = {}) {
    const { sessionId, timeoutMs, ...evaluateParams } = options ?? {};
    const result = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        ...evaluateParams
      },
      { sessionId, timeoutMs }
    );

    if (result?.exceptionDetails) {
      const message =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "Runtime.evaluate failed";
      throw new Error(message);
    }

    return result?.result?.value;
  }

  async attachToTarget(targetId) {
    const attached = await this.send("Target.attachToTarget", {
      targetId,
      flatten: true
    });
    const sessionId = typeof attached?.sessionId === "string" ? attached.sessionId : null;

    if (!sessionId) {
      throw new Error(`Failed to attach to target: ${targetId}`);
    }

    return new CdpSessionClient(this, sessionId);
  }

  async detachFromTarget(sessionId) {
    await this.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    this.removeSessionHandlers(sessionId);
  }

  removeSessionHandlers(sessionId) {
    for (const key of [...this.sessionEventHandlers.keys()]) {
      if (key.startsWith(`${sessionId}:`)) {
        this.sessionEventHandlers.delete(key);
      }
    }
  }

  rejectAllPending(reason) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${reason} (${pending.method})`));
    }

    this.pending.clear();
  }

  close() {
    this.rejectAllPending("CDP client closed");

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close();
    }
  }
}

/** A flat-session view of a target attached through a browser-level CdpClient. */
export class CdpSessionClient {
  constructor(rootClient, sessionId) {
    this.rootClient = rootClient;
    this.sessionId = sessionId;
  }

  on(method, handler) {
    this.rootClient.on(method, handler, this.sessionId);
  }

  send(method, params = {}, options = {}) {
    return this.rootClient.send(method, params, { ...options, sessionId: this.sessionId });
  }

  evaluate(expression, options = {}) {
    return this.rootClient.evaluate(expression, { ...options, sessionId: this.sessionId });
  }

  close() {
    return this.rootClient.detachFromTarget(this.sessionId);
  }
}

/** Names the command in a timeout; `Runtime.evaluate` gets an expression preview to tell steps apart. */
function describeCdpCommand(method, params) {
  if (method !== "Runtime.evaluate" || typeof params?.expression !== "string") {
    return method;
  }

  const preview = params.expression
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, CDP_EXPRESSION_PREVIEW_CHARS);

  return `${method} (${preview})`;
}

export async function closeClient(client) {
  if (!client || typeof client.close !== "function") {
    return;
  }

  await Promise.resolve(client.close()).catch(() => undefined);
}
