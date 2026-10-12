/**
 * Size budgets of the drill-down tools: every result stays small by default, says when it cut
 * something, and hands out a cursor or an id to get the rest.
 */

export type TextCut = {
  text: string;
  /** UTF-8 bytes of the whole text. */
  totalBytes: number;
  /** UTF-8 bytes returned. */
  returnedBytes: number;
  truncated: boolean;
  /** `"16384 of 90210 bytes"` when cut, otherwise null. */
  note: string | null;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

/** Cuts text to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function cutText(value: string, maxBytes: number): TextCut {
  const bytes = encoder.encode(value);

  if (bytes.byteLength <= maxBytes) {
    return {
      text: value,
      totalBytes: bytes.byteLength,
      returnedBytes: bytes.byteLength,
      truncated: false,
      note: null
    };
  }

  let end = Math.max(0, maxBytes);

  // Step back over UTF-8 continuation bytes (10xxxxxx) so the cut lands on a character boundary.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }

  return {
    text: decoder.decode(bytes.subarray(0, end)),
    totalBytes: bytes.byteLength,
    returnedBytes: end,
    truncated: true,
    note: `${end} of ${bytes.byteLength} bytes`
  };
}

export function jsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value) ?? "");
}

/**
 * The leading rows whose JSON fits in `maxBytes`. At least one row is kept, so paging always
 * advances; rows are expected to be compact already.
 */
export function fitRows<T>(rows: readonly T[], maxBytes: number): { rows: T[]; cut: boolean } {
  const kept: T[] = [];
  let used = 2;

  for (const row of rows) {
    const size = jsonBytes(row) + 1;

    if (kept.length > 0 && used + size > maxBytes) {
      return { rows: kept, cut: true };
    }

    kept.push(row);
    used += size;
  }

  return { rows: kept, cut: false };
}

const CURSOR_PATTERN = /^o:(\d{1,9})$/;

/** Opaque paging cursor: valid only with the same tool arguments it came with. */
export function encodeCursor(offset: number): string {
  return `o:${offset}`;
}

export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }

  const match = CURSOR_PATTERN.exec(cursor.trim());

  if (!match?.[1]) {
    throw new Error(`Invalid cursor '${cursor}': pass the nextCursor value of a previous call.`);
  }

  return Number(match[1]);
}

/** One page of rows plus what the agent needs to ask for the next one. */
export type Page<T> = {
  rows: T[];
  total: number;
  offset: number;
  /** Rows were left out (by `limit` or `maxBytes`); `nextCursor` continues. */
  truncated: boolean;
  nextCursor: string | null;
};

export function paginate<T>(
  rows: readonly T[],
  options: { cursor?: string; limit: number; maxBytes: number }
): Page<T> {
  const offset = Math.min(decodeCursor(options.cursor), rows.length);
  const fitted = fitRows(rows.slice(offset, offset + options.limit), options.maxBytes);
  const next = offset + fitted.rows.length;
  const hasMore = next < rows.length;

  return {
    rows: fitted.rows,
    total: rows.length,
    offset,
    truncated: hasMore,
    nextCursor: hasMore ? encodeCursor(next) : null
  };
}

/** A list cut to `limit` items, with its full length. */
export type CappedList<T> = {
  total: number;
  items: T[];
  truncated: boolean;
};

export function capList<T>(items: readonly T[], limit: number): CappedList<T> {
  return {
    total: items.length,
    items: items.slice(0, limit),
    truncated: items.length > limit
  };
}

/**
 * Halves the largest `CappedList` of a freshly built result until its JSON fits `maxBytes`,
 * marking each list it shortened. Returns the paths of the lists it cut.
 */
export function shrinkListsToBudget(result: Record<string, unknown>, maxBytes: number): string[] {
  const shrunk = new Set<string>();

  while (jsonBytes(result) > maxBytes) {
    const largest = findLargestCappedList(result, "");

    if (!largest || largest.list.items.length <= 1) {
      break;
    }

    largest.list.items = largest.list.items.slice(0, Math.ceil(largest.list.items.length / 2));
    largest.list.truncated = true;
    shrunk.add(largest.path);
  }

  return [...shrunk];
}

type FoundList = { path: string; list: CappedList<unknown>; size: number };

function findLargestCappedList(value: unknown, path: string): FoundList | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  let best: FoundList | null =
    isCappedList(record) && record.items.length > 1
      ? { path: path || ".", list: record, size: jsonBytes(record.items) }
      : null;

  for (const [key, child] of Object.entries(record)) {
    const found = findLargestCappedList(child, path ? `${path}.${key}` : key);

    if (found && found.list.items.length > 1 && (!best || found.size > best.size)) {
      best = found;
    }
  }

  return best;
}

function isCappedList(value: Record<string, unknown>): value is CappedList<unknown> {
  return (
    Array.isArray(value.items) &&
    typeof value.total === "number" &&
    typeof value.truncated === "boolean"
  );
}
