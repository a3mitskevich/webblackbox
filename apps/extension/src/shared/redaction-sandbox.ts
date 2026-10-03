import { redactBodyText, type RedactionProfile } from "@webblackbox/protocol";
import { createRedactionHashKey, redactPayload } from "@webblackbox/recorder";

/** What kind of sample the redaction sandbox receives. */
export type RedactionSandboxKind = "body" | "event" | "headers" | "url";

export type RedactionSandboxInput = {
  kind: RedactionSandboxKind;
  text: string;
};

export type RedactionSandboxResult = {
  kind: RedactionSandboxKind;
  output: string;
  changed: boolean;
  error?: string;
};

export type RedactionSandboxOptions = {
  /** Key for hashed values; defaults to a fresh random key so previews never reveal real hashes. */
  hashKey?: Uint8Array;
};

/**
 * Shows what a redaction profile hides in a pasted sample, using the exact functions the recorder
 * runs: `redactBodyText` for network bodies (JSON, form, XML/HTML, plain text) and `redactPayload`
 * for event payloads, headers and URLs. Pure: no I/O, safe to call from any extension page.
 */
export function previewRedaction(
  input: RedactionSandboxInput,
  profile: RedactionProfile,
  options: RedactionSandboxOptions = {}
): RedactionSandboxResult {
  const hashKey = options.hashKey ?? createRedactionHashKey();

  switch (input.kind) {
    case "body":
      return toResult(input, redactBodyText(input.text, profile.redactBodyPatterns).value);
    case "url":
      return toResult(input, readString(redactPayload({ url: input.text }, profile, { hashKey })));
    case "headers":
      return previewHeaders(input, profile, hashKey);
    case "event":
      return previewEventPayload(input, profile, hashKey);
  }
}

function previewHeaders(
  input: RedactionSandboxInput,
  profile: RedactionProfile,
  hashKey: Uint8Array
): RedactionSandboxResult {
  const headers = parseHeaderLines(input.text);
  const redacted = redactPayload({ headers: Object.fromEntries(headers) }, profile, { hashKey });
  const redactedHeaders = asRecord(asRecord(redacted)?.headers) ?? {};
  const output = headers
    .map(([name]) => `${name}: ${String(redactedHeaders[name] ?? "")}`)
    .join("\n");

  return toResult(input, output, {
    normalizedInput: headers.map(([name, value]) => `${name}: ${value}`).join("\n")
  });
}

function previewEventPayload(
  input: RedactionSandboxInput,
  profile: RedactionProfile,
  hashKey: Uint8Array
): RedactionSandboxResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(input.text);
  } catch {
    return { kind: input.kind, output: input.text, changed: false, error: "invalid-json" };
  }

  return toResult(input, JSON.stringify(redactPayload(parsed, profile, { hashKey }), null, 2), {
    normalizedInput: JSON.stringify(parsed, null, 2)
  });
}

function parseHeaderLines(text: string): Array<[string, string]> {
  const output: Array<[string, string]> = [];

  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf(":", line.startsWith(":") ? 1 : 0);

    if (separator <= 0) {
      continue;
    }

    const name = line.slice(0, separator).trim().toLowerCase();

    if (name) {
      output.push([name, line.slice(separator + 1).trim()]);
    }
  }

  return output;
}

function toResult(
  input: RedactionSandboxInput,
  output: string,
  options: { normalizedInput?: string } = {}
): RedactionSandboxResult {
  return {
    kind: input.kind,
    output,
    changed: output !== (options.normalizedInput ?? input.text)
  };
}

function readString(value: unknown): string {
  return typeof asRecord(value)?.url === "string" ? String(asRecord(value)?.url) : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
