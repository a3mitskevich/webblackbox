// "Bytes through the port": the service worker measures the JSON size of every message it
// exchanges with the offscreen document while this flag is on (src/sw/port-traffic.ts).
const PORT_TRAFFIC_FLAG = "__WEBBLACKBOX_PORT_TRAFFIC__";
const PORT_TRAFFIC_STATS_KEY = "__WEBBLACKBOX_PORT_TRAFFIC_STATS__";

/** Turns the meter on in the worker; the totals restart with the worker. */
export async function enablePortTrafficMeter(swClient) {
  await swClient.send("Runtime.evaluate", {
    expression: `globalThis.${PORT_TRAFFIC_FLAG} = true`,
    returnByValue: true
  });
}

/** The worker's totals so far, or null when the meter saw nothing (or the worker restarted). */
export async function readPortTrafficStats(swClient) {
  const response = await swClient.send("Runtime.evaluate", {
    expression: `globalThis.${PORT_TRAFFIC_STATS_KEY} ?? null`,
    returnByValue: true
  });
  const value = response?.result?.value;
  return value && typeof value === "object" ? value : null;
}

/**
 * One-line summary: wire bytes each way, and for every kind that carried binary data how many
 * wire bytes each raw byte cost.
 */
export function summarizePortTraffic(stats) {
  if (!stats) {
    return null;
  }

  const binaryKinds = Object.entries(stats.byKind ?? {})
    .filter(([, counter]) => counter.binaryBytes > 0)
    .map(([kind, counter]) => ({
      kind,
      messages: counter.messages,
      bytes: counter.bytes,
      binaryBytes: counter.binaryBytes,
      wirePerBinaryByte: Number((counter.bytes / counter.binaryBytes).toFixed(2))
    }));

  return {
    sentMessages: stats.sent.messages,
    sentBytes: stats.sent.bytes,
    receivedMessages: stats.received.messages,
    receivedBytes: stats.received.bytes,
    totalBytes: stats.sent.bytes + stats.received.bytes,
    binaryBytes: stats.sent.binaryBytes + stats.received.binaryBytes,
    binaryKinds
  };
}
