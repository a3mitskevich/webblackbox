import type { NetworkEnableParams } from "@webblackbox/cdp-router";

/**
 * Chrome's own response body buffer per debugger session (measured on Chrome 153): about 200 MB in
 * total, oldest bodies evicted first, and no body over about 20 MB kept at all. They are the
 * floors: a session never gets less than Chrome would keep.
 */
export const CHROME_DEFAULT_TOTAL_BUFFER_BYTES = 200 * 1000 * 1000;
export const CHROME_DEFAULT_RESOURCE_BUFFER_BYTES = 20 * 1000 * 1000;

/**
 * Total body buffer per byte of the per-body limit: room for a burst of large responses that
 * finish while earlier bodies are still being read (1 MiB limit → 256 MiB).
 */
export const NETWORK_TOTAL_BUFFER_PER_BODY_LIMIT = 256;
/** Ceiling of the total body buffer; it lives in the page's renderer. */
export const NETWORK_TOTAL_BUFFER_MAX_BYTES = 512 * 1024 * 1024;

/**
 * Per-resource body buffer per byte of the per-body limit. Bodies are read whole up to twice the
 * limit of encoded bytes, and compressed text decodes to several times that.
 */
export const NETWORK_RESOURCE_BUFFER_PER_BODY_LIMIT = 16;
/** Ceiling of the per-resource body buffer. */
export const NETWORK_RESOURCE_BUFFER_MAX_BYTES = 64 * 1024 * 1024;

/**
 * `Network.enable` buffer sizes for a session that keeps response bodies up to `bodyLimitBytes`
 * each. Without bodies Chrome keeps its defaults (no sizes are sent). Request bodies up to the
 * limit come inline in `Network.requestWillBeSent`, so they need no extra read.
 */
export function resolveNetworkEnableParams(bodyLimitBytes: number): NetworkEnableParams {
  if (!Number.isFinite(bodyLimitBytes) || bodyLimitBytes <= 0) {
    return {};
  }

  const limit = Math.round(bodyLimitBytes);
  const maxResourceBufferSize = clamp(
    limit * NETWORK_RESOURCE_BUFFER_PER_BODY_LIMIT,
    CHROME_DEFAULT_RESOURCE_BUFFER_BYTES,
    NETWORK_RESOURCE_BUFFER_MAX_BYTES
  );
  const maxTotalBufferSize = clamp(
    limit * NETWORK_TOTAL_BUFFER_PER_BODY_LIMIT,
    Math.max(CHROME_DEFAULT_TOTAL_BUFFER_BYTES, maxResourceBufferSize),
    NETWORK_TOTAL_BUFFER_MAX_BYTES
  );

  return { maxTotalBufferSize, maxResourceBufferSize, maxPostDataSize: limit };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
