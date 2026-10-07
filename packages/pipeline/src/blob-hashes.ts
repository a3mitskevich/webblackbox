import type { WebBlackboxEvent } from "@webblackbox/protocol";

export const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

/** Every SHA-256 hex string in the events' payloads (blob references), sorted. */
export function collectBlobHashesFromEvents(events: WebBlackboxEvent[]): string[] {
  const hashes = new Set<string>();

  for (const event of events) {
    collectBlobHashesFromUnknown(event.data, hashes);
  }

  return [...hashes].sort();
}

export function collectBlobHashesFromUnknown(value: unknown, output: Set<string>): void {
  const stack: unknown[] = [value];

  while (stack.length > 0) {
    const current = stack.pop();

    if (typeof current === "string") {
      if (SHA256_HEX_PATTERN.test(current)) {
        output.add(current);
      }

      continue;
    }

    if (!current || typeof current !== "object") {
      continue;
    }

    if (Array.isArray(current)) {
      for (const entry of current) {
        stack.push(entry);
      }
      continue;
    }

    for (const entry of Object.values(current as Record<string, unknown>)) {
      stack.push(entry);
    }
  }
}

export function normalizeBlobHashes(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const output = new Set<string>();

  for (const value of values) {
    if (typeof value === "string" && SHA256_HEX_PATTERN.test(value)) {
      output.add(value);
    }
  }

  return [...output];
}

export function mergeBlobHashes(...sources: unknown[]): string[] {
  const output = new Set<string>();

  for (const source of sources) {
    for (const hash of normalizeBlobHashes(source)) {
      output.add(hash);
    }
  }

  return [...output];
}

export function normalizeTrackingSid(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
