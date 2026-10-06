import type { PortLike } from "../shared/chrome-api.js";
import type { ExtensionOutboundMessage } from "../shared/messages.js";
import { isBroadcastDeliveredToPort } from "./port-sender.js";
import type { PortTrafficMeter } from "./port-traffic.js";

export type PortRegistryDeps = {
  offscreenPortTraffic: PortTrafficMeter;
  shouldLogPortDebug: () => boolean;
};

export type PortRegistry = {
  addPort: (port: PortLike) => void;
  removePort: (port: PortLike) => void;
  hasPort: (port: PortLike) => boolean;
  getOffscreenPort: () => PortLike | null;
  /** Binds the offscreen document's port: pipeline traffic is measured on it. */
  setOffscreenPort: (port: PortLike) => void;
  /** Drops the offscreen binding only when it still points at this port. */
  clearOffscreenPort: (port: PortLike) => boolean;
  /** Forgets a port after a failed send, including its offscreen binding. */
  dropPort: (port: PortLike) => void;
  broadcast: (message: ExtensionOutboundMessage) => void;
  sendPortMessage: (port: PortLike, message: ExtensionOutboundMessage) => void;
};

export function logPortSendFailure(
  shouldLogPortDebug: () => boolean,
  kind: string,
  error: unknown,
  context: Record<string, unknown> = {}
): void {
  if (!shouldLogPortDebug()) {
    return;
  }

  console.debug("[WebBlackbox][port] service worker postMessage failed", {
    kind,
    ...context,
    error: error instanceof Error ? error.message : String(error)
  });
}

/**
 * The connected extension ports and the offscreen document's port. Sends are best effort: a
 * port that throws on `postMessage` is dead (its context went away) and is forgotten, so later
 * broadcasts skip it.
 */
export function createPortRegistry(deps: PortRegistryDeps): PortRegistry {
  const connectedPorts = new Set<PortLike>();
  let offscreenPort: PortLike | null = null;

  function dropPort(port: PortLike): void {
    connectedPorts.delete(port);

    if (offscreenPort === port) {
      offscreenPort = null;
    }
  }

  function broadcast(message: ExtensionOutboundMessage): void {
    for (const port of connectedPorts) {
      if (isBroadcastDeliveredToPort(message.kind, port.name)) {
        sendPortMessage(port, message);
      }
    }
  }

  function sendPortMessage(port: PortLike, message: ExtensionOutboundMessage): void {
    try {
      if (port === offscreenPort) {
        deps.offscreenPortTraffic.recordSent(message.kind, message);
      }

      port.postMessage(message);
    } catch (error) {
      dropPort(port);
      logPortSendFailure(deps.shouldLogPortDebug, message.kind, error, {
        portName: port.name
      });
    }
  }

  return {
    addPort: (port) => {
      connectedPorts.add(port);
    },
    removePort: (port) => {
      connectedPorts.delete(port);
    },
    hasPort: (port) => connectedPorts.has(port),
    getOffscreenPort: () => offscreenPort,
    setOffscreenPort: (port) => {
      offscreenPort = port;
    },
    clearOffscreenPort: (port) => {
      if (offscreenPort !== port) {
        return false;
      }

      offscreenPort = null;
      return true;
    },
    dropPort,
    broadcast,
    sendPortMessage
  };
}
