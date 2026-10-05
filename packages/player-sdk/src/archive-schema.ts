import {
  ARCHIVE_FORMAT_VERSION,
  WEBBLACKBOX_PROTOCOL_VERSION,
  exportEncryptionSchema,
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

/** Archive formats this reader understands: 1 (plain manifest) and 2 (envelope + encrypted manifest). */
const SUPPORTED_PROTOCOL_VERSIONS: readonly unknown[] = [
  WEBBLACKBOX_PROTOCOL_VERSION,
  ARCHIVE_FORMAT_VERSION
];

/**
 * Plaintext `manifest.json` of a format-2 archive: only the protocol version and the encryption
 * parameters. The full manifest is the encrypted `meta/manifest.json`.
 */
export function parseArchiveEnvelope(
  bytes: Uint8Array
): Pick<ExportManifest, "protocolVersion" | "encryption"> {
  const value = parseJsonBytes("manifest.json", bytes);
  const record =
    value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  assertSupportedProtocolVersion(record.protocolVersion);

  return {
    protocolVersion: record.protocolVersion as ExportManifest["protocolVersion"],
    ...(record.encryption === undefined
      ? {}
      : {
          encryption: validateArchiveJson(
            "manifest.json encryption",
            record.encryption,
            exportEncryptionSchema
          )
        })
  };
}

function assertSupportedProtocolVersion(protocolVersion: unknown): void {
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    throw new Error(
      `Unsupported archive protocolVersion ${describeValue(protocolVersion)}; ` +
        `this player supports protocolVersion ${SUPPORTED_PROTOCOL_VERSIONS.join(" and ")}.`
    );
  }
}

/** Parses a full manifest, rejecting unknown protocol versions before schema validation. */
export function parseArchiveManifest(bytes: Uint8Array, path = "manifest.json"): ExportManifest {
  const value = parseJsonBytes(path, bytes);
  assertSupportedProtocolVersion(
    value !== null && typeof value === "object"
      ? (value as { protocolVersion?: unknown }).protocolVersion
      : undefined
  );

  return validateArchiveJson(path, value, exportManifestSchema);
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
