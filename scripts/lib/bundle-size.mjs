// Pure logic of the bundle-size gate (`scripts/check-bundle-size.mjs`); see bundle-size/README.md.

const NOTE_PATTERN = /^[ \t]*size-increase:[ \t]*(\S+?):?[ \t]+(\S[^\n]*)$/gim;

/**
 * @typedef {{ path: string, maxBytes?: number, maxGzipBytes?: number, forbidSources: string[], note?: string }} AbsoluteBudget
 * @typedef {{ maxGrowthPercent: number, minGrowthBytes: number, entries: string[] }} DeltaPolicy
 * @typedef {{ absolute: AbsoluteBudget[], delta: DeltaPolicy }} BudgetConfig
 * @typedef {{ path: string, bytes: number, gzipBytes: number }} SizeRow
 * @typedef {{ target: string, reason: string }} SizeIncreaseNote
 * @typedef {{ status: "new" | "ok" | "explained" | "failed", growthBytes: number | null, limitBytes: number | null, reason: string | null, message: string | null }} DeltaResult
 */

/**
 * Validates the parsed `bundle-size/budgets.json`.
 * @param {unknown} value
 * @returns {BudgetConfig}
 */
export function parseBudgetConfig(value) {
  if (!isRecord(value)) {
    throw new Error("budgets.json must be a JSON object");
  }

  const absolute = Array.isArray(value.absolute) ? value.absolute.map(parseAbsoluteBudget) : [];
  const delta = parseDeltaPolicy(value.delta);

  if (absolute.length === 0 && delta.entries.length === 0) {
    throw new Error("budgets.json declares no bundles");
  }

  return { absolute, delta };
}

/**
 * Reads the size rows out of a report written by a previous run (the delta baseline).
 * @param {unknown} value
 * @returns {Map<string, SizeRow>}
 */
export function parseBaselineReport(value) {
  const rows = isRecord(value) && Array.isArray(value.report) ? value.report : null;

  if (!rows) {
    throw new Error("baseline report has no `report` array");
  }

  const baseline = new Map();

  for (const row of rows) {
    if (
      isRecord(row) &&
      typeof row.path === "string" &&
      isNonNegativeInteger(row.bytes) &&
      isNonNegativeInteger(row.gzipBytes)
    ) {
      baseline.set(row.path, { path: row.path, bytes: row.bytes, gzipBytes: row.gzipBytes });
    }
  }

  return baseline;
}

/**
 * Collects `size-increase: <bundle> <reason>` lines from PR commit messages and the PR body.
 * @param {string} text
 * @returns {SizeIncreaseNote[]}
 */
export function parseSizeIncreaseNotes(text) {
  return [...text.matchAll(NOTE_PATTERN)].map((match) => ({
    target: match[1] ?? "",
    reason: (match[2] ?? "").trim()
  }));
}

/**
 * Finds the note that explains growth of `path`: by full path, by file name, or `*` for all.
 * @param {SizeIncreaseNote[]} notes
 * @param {string} path
 * @returns {SizeIncreaseNote | undefined}
 */
export function findSizeIncreaseNote(notes, path) {
  const fileName = fileNameOf(path);

  return notes.find(
    (note) => note.target === path || note.target === fileName || note.target === "*"
  );
}

/**
 * Checks one bundle against its strict budget and its forbidden sourcemap sources.
 * @param {AbsoluteBudget} budget
 * @param {SizeRow} size
 * @param {string[] | null} sources sourcemap `sources`, or null when the map is missing
 * @returns {string[]} failures
 */
export function evaluateAbsoluteBudget(budget, size, sources) {
  const failures = [];

  if (budget.maxBytes !== undefined && size.bytes > budget.maxBytes) {
    failures.push(
      `${budget.path}: raw size ${size.bytes} exceeds budget ${budget.maxBytes} (+${size.bytes - budget.maxBytes})`
    );
  }

  if (budget.maxGzipBytes !== undefined && size.gzipBytes > budget.maxGzipBytes) {
    failures.push(
      `${budget.path}: gzip size ${size.gzipBytes} exceeds budget ${budget.maxGzipBytes} (+${size.gzipBytes - budget.maxGzipBytes})`
    );
  }

  if (budget.forbidSources.length === 0) {
    return failures;
  }

  if (sources === null) {
    return [...failures, `${budget.path}: no sourcemap, cannot check forbidden sources`];
  }

  for (const pattern of budget.forbidSources) {
    const hits = sources.filter((source) => source.includes(pattern));

    if (hits.length > 0) {
      failures.push(
        `${budget.path}: bundles ${hits.length} forbidden source(s) matching "${pattern}", e.g. ${hits[0]}`
      );
    }
  }

  return failures;
}

/**
 * Compares a bundle with the base branch. Growth above the threshold fails unless a note explains it.
 * @param {DeltaPolicy} policy
 * @param {SizeRow} size
 * @param {SizeRow | undefined} base
 * @param {SizeIncreaseNote[]} notes
 * @returns {DeltaResult}
 */
export function evaluateDelta(policy, size, base, notes) {
  if (!base) {
    return { status: "new", growthBytes: null, limitBytes: null, reason: null, message: null };
  }

  const growthBytes = size.bytes - base.bytes;
  const limitBytes = Math.max(
    policy.minGrowthBytes,
    Math.floor((base.bytes * policy.maxGrowthPercent) / 100)
  );

  if (growthBytes <= limitBytes) {
    return { status: "ok", growthBytes, limitBytes, reason: null, message: null };
  }

  const note = findSizeIncreaseNote(notes, size.path);

  if (note) {
    return {
      status: "explained",
      growthBytes,
      limitBytes,
      reason: note.reason,
      message: `${size.path}: +${growthBytes} B over base (limit ${limitBytes} B), explained: ${note.reason}`
    };
  }

  return {
    status: "failed",
    growthBytes,
    limitBytes,
    reason: null,
    message:
      `${size.path}: grew by ${growthBytes} B (${formatPercent(growthBytes, base.bytes)}) over the base ` +
      `branch, above the ${policy.maxGrowthPercent}% / ${policy.minGrowthBytes} B threshold. If this ` +
      `is intended, add "size-increase: ${fileNameOf(size.path)} <reason>" to a commit message or the PR body.`
  };
}

/**
 * @param {number} delta
 * @param {number} base
 * @returns {string}
 */
export function formatPercent(delta, base) {
  if (base === 0) {
    return "n/a";
  }

  const percent = (delta / base) * 100;

  return `${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%`;
}

/**
 * @param {unknown} value
 * @returns {AbsoluteBudget}
 */
function parseAbsoluteBudget(value) {
  if (!isRecord(value) || typeof value.path !== "string" || value.path.length === 0) {
    throw new Error("every absolute budget needs a `path`");
  }

  const maxBytes = optionalPositiveInteger(value.maxBytes, `${value.path}.maxBytes`);
  const maxGzipBytes = optionalPositiveInteger(value.maxGzipBytes, `${value.path}.maxGzipBytes`);
  const forbidSources = value.forbidSources ?? [];

  if (!Array.isArray(forbidSources) || !forbidSources.every((item) => typeof item === "string")) {
    throw new Error(`${value.path}.forbidSources must be an array of strings`);
  }

  if (maxBytes === undefined && maxGzipBytes === undefined) {
    throw new Error(`${value.path}: an absolute budget needs maxBytes or maxGzipBytes`);
  }

  return {
    path: value.path,
    maxBytes,
    maxGzipBytes,
    forbidSources,
    note: typeof value.note === "string" ? value.note : undefined
  };
}

/**
 * @param {unknown} value
 * @returns {DeltaPolicy}
 */
function parseDeltaPolicy(value) {
  if (value === undefined) {
    return { maxGrowthPercent: 0, minGrowthBytes: 0, entries: [] };
  }

  if (!isRecord(value)) {
    throw new Error("`delta` must be an object");
  }

  const entries = Array.isArray(value.entries) ? value.entries : [];

  if (!entries.every((entry) => typeof entry === "string" && entry.length > 0)) {
    throw new Error("`delta.entries` must be bundle paths");
  }

  if (typeof value.maxGrowthPercent !== "number" || !(value.maxGrowthPercent >= 0)) {
    throw new Error("`delta.maxGrowthPercent` must be a non-negative number");
  }

  if (!isNonNegativeInteger(value.minGrowthBytes)) {
    throw new Error("`delta.minGrowthBytes` must be a non-negative integer");
  }

  return {
    maxGrowthPercent: value.maxGrowthPercent,
    minGrowthBytes: value.minGrowthBytes,
    entries
  };
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number | undefined}
 */
function optionalPositiveInteger(value, label) {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  return Number(value);
}

/** @param {string} path */
function fileNameOf(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isNonNegativeInteger(value) {
  return Number.isInteger(value) && Number(value) >= 0;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
