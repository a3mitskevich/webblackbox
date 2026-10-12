// The recorder's manifest (`evals/archives/manifest.json`, git-ignored): which archive holds which
// scenario and profile, whether the bug reproduced, and the passphrase the archives use.

import { readFile, writeFile } from "node:fs/promises";

export type ManifestEntry = {
  caseId: string;
  scenarioId: string;
  profile: string;
  /** Archive path relative to the manifest's directory. */
  file: string;
  bytes: number;
  /** The scenario's symptom was visible on the page at the end of the steps. */
  symptomReproduced: boolean;
  recordedAt: string;
  error?: string;
};

export type ArchiveManifest = {
  version: 1;
  createdAt: string;
  passphrase: string;
  entries: readonly ManifestEntry[];
};

export async function readManifest(path: string): Promise<ArchiveManifest | null> {
  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }

  return parseManifest(JSON.parse(text));
}

export async function writeManifest(path: string, manifest: ArchiveManifest): Promise<void> {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Replaces the entries recorded again (same case and profile) and keeps the others. */
export function mergeEntries(
  previous: readonly ManifestEntry[],
  recorded: readonly ManifestEntry[]
): readonly ManifestEntry[] {
  const key = (entry: ManifestEntry) => `${entry.profile}/${entry.caseId}`;
  const replaced = new Set(recorded.map(key));

  return [...previous.filter((entry) => !replaced.has(key(entry))), ...recorded].sort((a, b) =>
    key(a).localeCompare(key(b))
  );
}

export function parseManifest(value: unknown): ArchiveManifest {
  if (!isRecord(value) || value.version !== 1 || typeof value.passphrase !== "string") {
    throw new Error("Archive manifest: unsupported format");
  }

  if (!Array.isArray(value.entries)) {
    throw new Error("Archive manifest: entries missing");
  }

  return {
    version: 1,
    createdAt: String(value.createdAt ?? ""),
    passphrase: value.passphrase,
    entries: value.entries.map(parseEntry)
  };
}

function parseEntry(value: unknown, index: number): ManifestEntry {
  if (
    !isRecord(value) ||
    typeof value.caseId !== "string" ||
    typeof value.scenarioId !== "string" ||
    typeof value.profile !== "string" ||
    typeof value.file !== "string" ||
    typeof value.bytes !== "number" ||
    typeof value.symptomReproduced !== "boolean"
  ) {
    throw new Error(`Archive manifest: entry ${index} is malformed`);
  }

  return {
    caseId: value.caseId,
    scenarioId: value.scenarioId,
    profile: value.profile,
    file: value.file,
    bytes: value.bytes,
    symptomReproduced: value.symptomReproduced,
    recordedAt: String(value.recordedAt ?? ""),
    ...(typeof value.error === "string" ? { error: value.error } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
