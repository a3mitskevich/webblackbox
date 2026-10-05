import {
  WEBBLACKBOX_PROTOCOL_VERSION,
  exportManifestSchema,
  hashesManifestSchema,
  invertedIndexSchema,
  privacyManifestSchema,
  requestIndexSchema,
  timeIndexSchema
} from "@webblackbox/protocol";
import type {
  ChunkTimeIndexEntry,
  ExportManifest,
  HashesManifest,
  InvertedIndexEntry,
  PrivacyManifest,
  RequestIndexEntry
} from "@webblackbox/protocol";

const MAX_REPORTED_ISSUES = 3;

type SchemaIssue = {
  path: ReadonlyArray<PropertyKey>;
  message: string;
};

type ArchiveSchema<TValue> = {
  safeParse(
    value: unknown
  ): { success: true; data: TValue } | { success: false; error: { issues: SchemaIssue[] } };
};

/** Parses and validates `integrity/hashes.json`. */
export function parseArchiveIntegrity(bytes: Uint8Array): HashesManifest {
  return parseArchiveJson("integrity/hashes.json", bytes, hashesManifestSchema);
}

/** Parses `manifest.json`, rejecting unknown protocol versions before schema validation. */
export function parseArchiveManifest(bytes: Uint8Array): ExportManifest {
  const value = parseJsonBytes("manifest.json", bytes);
  const protocolVersion =
    typeof value === "object" && value !== null
      ? (value as { protocolVersion?: unknown }).protocolVersion
      : undefined;

  if (protocolVersion !== WEBBLACKBOX_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported archive protocolVersion ${describeValue(protocolVersion)}; ` +
        `this player supports protocolVersion ${WEBBLACKBOX_PROTOCOL_VERSION}.`
    );
  }

  return validateArchiveJson("manifest.json", value, exportManifestSchema);
}

/** Parses and validates `index/time.json`. */
export function parseArchiveTimeIndex(bytes: Uint8Array): ChunkTimeIndexEntry[] {
  return parseArchiveJson("index/time.json", bytes, timeIndexSchema);
}

/** Parses and validates `index/req.json`. */
export function parseArchiveRequestIndex(bytes: Uint8Array): RequestIndexEntry[] {
  return parseArchiveJson("index/req.json", bytes, requestIndexSchema);
}

/** Parses and validates `index/inv.json`. */
export function parseArchiveInvertedIndex(bytes: Uint8Array): InvertedIndexEntry[] {
  return parseArchiveJson("index/inv.json", bytes, invertedIndexSchema);
}

/** Parses and validates `privacy/manifest.json`. */
export function parseArchivePrivacyManifest(bytes: Uint8Array): PrivacyManifest {
  return parseArchiveJson("privacy/manifest.json", bytes, privacyManifestSchema);
}

function parseArchiveJson<TValue>(
  path: string,
  bytes: Uint8Array,
  schema: ArchiveSchema<TValue>
): TValue {
  return validateArchiveJson(path, parseJsonBytes(path, bytes), schema);
}

function validateArchiveJson<TValue>(
  path: string,
  value: unknown,
  schema: ArchiveSchema<TValue>
): TValue {
  const result = schema.safeParse(value);

  if (result.success) {
    return result.data;
  }

  const issues = result.error.issues;
  const details = issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`)
    .join("; ");
  const more =
    issues.length > MAX_REPORTED_ISSUES
      ? ` (+${issues.length - MAX_REPORTED_ISSUES} more issues)`
      : "";

  throw new Error(`Invalid archive ${path}: ${details}${more}`);
}

function parseJsonBytes(path: string, bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new Error(
      `Archive file ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
  return path.length > 0 ? path.map((segment) => String(segment)).join(".") : "(root)";
}

function describeValue(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }

  return value === undefined ? "(missing)" : `of type ${typeof value}`;
}
