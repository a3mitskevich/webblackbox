/** Set to `true` in the worker (e2e, DevTools) to measure what crosses the offscreen port. */
export const PORT_TRAFFIC_FLAG = "__WEBBLACKBOX_PORT_TRAFFIC__";
/** While the flag is on, the latest totals are published here for the e2e to read. */
export const PORT_TRAFFIC_STATS_KEY = "__WEBBLACKBOX_PORT_TRAFFIC_STATS__";

export type PortTrafficCounter = {
  messages: number;
  /** Length of the messages' JSON form: what the port serializes and copies. */
  bytes: number;
  /** Raw size of the binary payloads (blobs, video chunks) those messages carried. */
  binaryBytes: number;
};

export type PortTrafficStats = {
  sent: PortTrafficCounter;
  received: PortTrafficCounter;
  /** Per request op (`putBlob`, `ingestBatch`…) or message kind, both directions. */
  byKind: Readonly<Record<string, PortTrafficCounter>>;
};

export type PortTrafficMeter = {
  recordSent(kind: string, message: unknown, binaryBytes?: number): void;
  recordReceived(kind: string, message: unknown, binaryBytes?: number): void;
  snapshot(): PortTrafficStats;
};

const EMPTY_COUNTER: PortTrafficCounter = { messages: 0, bytes: 0, binaryBytes: 0 };

/**
 * Counts the serialized size of offscreen port messages. Off by default: measuring costs a
 * `JSON.stringify` per message, so it only runs while `PORT_TRAFFIC_FLAG` is set on `scope`.
 */
export function createPortTrafficMeter(
  scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>
): PortTrafficMeter {
  let stats: PortTrafficStats = { sent: EMPTY_COUNTER, received: EMPTY_COUNTER, byKind: {} };

  const record = (
    direction: "sent" | "received",
    kind: string,
    message: unknown,
    binaryBytes: number
  ): void => {
    if (scope[PORT_TRAFFIC_FLAG] !== true) {
      return;
    }

    const bytes = measureJsonBytes(message);
    stats = {
      ...stats,
      [direction]: addTraffic(stats[direction], bytes, binaryBytes),
      byKind: {
        ...stats.byKind,
        [kind]: addTraffic(stats.byKind[kind] ?? EMPTY_COUNTER, bytes, binaryBytes)
      }
    };
    scope[PORT_TRAFFIC_STATS_KEY] = stats;
  };

  return {
    recordSent: (kind, message, binaryBytes = 0) => record("sent", kind, message, binaryBytes),
    recordReceived: (kind, message, binaryBytes = 0) =>
      record("received", kind, message, binaryBytes),
    snapshot: () => stats
  };
}

function addTraffic(
  counter: PortTrafficCounter,
  bytes: number,
  binaryBytes: number
): PortTrafficCounter {
  return {
    messages: counter.messages + 1,
    bytes: counter.bytes + bytes,
    binaryBytes: counter.binaryBytes + binaryBytes
  };
}

function measureJsonBytes(message: unknown): number {
  try {
    return JSON.stringify(message)?.length ?? 0;
  } catch {
    return 0;
  }
}
