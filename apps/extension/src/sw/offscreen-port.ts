export type OffscreenPortConnectorDeps<TPort> = {
  /** Currently connected offscreen port, if any. */
  getPort(): TPort | null;
  /** Whether an offscreen document already exists for this extension. */
  hasDocument(): Promise<boolean>;
  createDocument(): Promise<void>;
  closeDocument(): Promise<void>;
  /**
   * Asks an existing offscreen document to open a new port. Needed after a service
   * worker restart: the document survives but its old port died with the worker.
   */
  requestReconnect(): Promise<void>;
  wait(ms: number): Promise<void>;
};

export type OffscreenPortConnectorOptions = {
  /** Time budget to wait for a port after each recovery step. */
  portWaitMs: number;
  pollMs: number;
};

export type OffscreenPortConnector<TPort> = {
  ensurePort(): Promise<TPort>;
};

export const OFFSCREEN_UNAVAILABLE_ERROR = "Offscreen pipeline is unavailable.";

/**
 * Resolves the offscreen pipeline port, recovering in escalating steps:
 * create a missing document, ask a surviving document to reconnect, and finally
 * recreate an unresponsive document. Concurrent callers share one attempt.
 */
export function createOffscreenPortConnector<TPort>(
  deps: OffscreenPortConnectorDeps<TPort>,
  options: OffscreenPortConnectorOptions
): OffscreenPortConnector<TPort> {
  let inFlight: Promise<TPort> | null = null;

  const waitForPort = async (): Promise<TPort | null> => {
    const attempts = Math.max(1, Math.ceil(options.portWaitMs / options.pollMs));

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const port = deps.getPort();

      if (port) {
        return port;
      }

      await deps.wait(options.pollMs);
    }

    return deps.getPort();
  };

  const recover = async (): Promise<TPort> => {
    if (await deps.hasDocument()) {
      await deps.requestReconnect().catch(() => undefined);
    } else {
      await deps.createDocument();
    }

    const reconnected = await waitForPort();

    if (reconnected) {
      return reconnected;
    }

    await deps.closeDocument().catch(() => undefined);
    await deps.createDocument();

    const recreated = await waitForPort();

    if (recreated) {
      return recreated;
    }

    throw new Error(OFFSCREEN_UNAVAILABLE_ERROR);
  };

  return {
    ensurePort(): Promise<TPort> {
      const port = deps.getPort();

      if (port) {
        return Promise.resolve(port);
      }

      if (!inFlight) {
        inFlight = recover().finally(() => {
          inFlight = null;
        });
      }

      return inFlight;
    }
  };
}
