#!/usr/bin/env node

import { gzipSync } from "node:zlib";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const budgetsPath = resolve(root, "bundle-size/budgets.json");
const reportPath = resolve(root, "bundle-size/latest-report.json");

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const content = await readFile(budgetsPath, "utf8");
  const budgets = JSON.parse(content);
  const entries = Array.isArray(budgets.entries) ? budgets.entries : [];

  if (entries.length === 0) {
    throw new Error(`No bundle budgets found in ${budgetsPath}`);
  }

  const report = [];
  const failures = [];

  for (const entry of entries) {
    const { label, bytes, gzipBytes, files } = await measureEntry(entry);
    const maxBytes = Number(entry.maxBytes);
    const maxGzipBytes = Number(entry.maxGzipBytes);

    const rawOk = Number.isFinite(maxBytes) ? bytes <= maxBytes : true;
    const gzipOk = Number.isFinite(maxGzipBytes) ? gzipBytes <= maxGzipBytes : true;

    report.push({
      path: label,
      ...(files === null ? {} : { files }),
      bytes,
      gzipBytes,
      maxBytes: Number.isFinite(maxBytes) ? maxBytes : null,
      maxGzipBytes: Number.isFinite(maxGzipBytes) ? maxGzipBytes : null,
      ok: rawOk && gzipOk
    });

    if (!rawOk) {
      failures.push(
        `${label}: raw size ${bytes} exceeds budget ${maxBytes} (+${bytes - maxBytes})`
      );
    }

    if (!gzipOk) {
      failures.push(
        `${label}: gzip size ${gzipBytes} exceeds budget ${maxGzipBytes} (+${gzipBytes - maxGzipBytes})`
      );
    }
  }

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        report
      },
      null,
      2
    ),
    "utf8"
  );

  for (const row of report) {
    console.log(`${row.path}: raw=${row.bytes} gzip=${row.gzipBytes}`);
  }
  console.log("Bundle size report:", reportPath);

  if (failures.length > 0) {
    throw new Error(`Bundle size budgets failed:\n- ${failures.join("\n- ")}`);
  }
}

/**
 * A budget covers one file (`path`) or every file under a directory with the given extensions
 * (`dir` + `extensions`, e.g. all JS and CSS chunks of a code-split app; source maps excluded).
 * Aggregate gzip is the sum of the per-file gzip sizes, as each file is served on its own.
 */
async function measureEntry(entry) {
  if (typeof entry.path === "string") {
    const source = await readFile(resolve(root, entry.path));
    return {
      label: entry.path,
      bytes: source.byteLength,
      gzipBytes: gzipSync(source).byteLength,
      files: null
    };
  }

  if (typeof entry.dir !== "string" || !Array.isArray(entry.extensions)) {
    throw new Error(`Budget entry needs "path" or "dir" + "extensions": ${JSON.stringify(entry)}`);
  }

  const extensions = new Set(entry.extensions.map((extension) => String(extension)));
  const dir = resolve(root, entry.dir);
  const paths = (await listFiles(dir)).filter((path) => extensions.has(extname(path)));

  if (paths.length === 0) {
    throw new Error(`No ${[...extensions].join("/")} files under ${entry.dir}`);
  }

  let bytes = 0;
  let gzipBytes = 0;

  for (const path of paths) {
    const source = await readFile(path);
    bytes += source.byteLength;
    gzipBytes += gzipSync(source).byteLength;
  }

  return {
    label: `${entry.dir}/**/*{${[...extensions].join(",")}}`,
    bytes,
    gzipBytes,
    files: paths.map((path) => relative(dir, path)).sort()
  };
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)]
    )
  );
  return nested.flat();
}
