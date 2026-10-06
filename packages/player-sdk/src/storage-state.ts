import type { WebBlackboxEvent } from "@webblackbox/protocol";

/** Storage areas the Player rebuilds. Cache Storage and service workers stay in the op log. */
export type StorageArea = "local" | "session" | "cookie" | "idb";

/** How much of an area the archive holds: values, key names only, counts only, or nothing. */
export type StorageCoverage = "values" | "names" | "counts" | "none";

export type StorageItem = {
  key: string;
  value?: string;
  valueLength?: number;
  valueTruncated?: boolean;
  /** The event that last wrote the key (snapshot or operation). */
  updatedEventId: string;
  updatedMono: number;
};

export type CookieItem = {
  name: string;
  value?: string;
  valueTruncated?: boolean;
  domain?: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  /** Seconds since the epoch; absent for session cookies. */
  expires?: number;
};

export type IdbRecordItem = { key: string; value: string; valueTruncated?: boolean };

export type IdbStoreItem = {
  name: string;
  count: number;
  records: IdbRecordItem[];
  truncated?: boolean;
};

export type IdbDatabaseItem = {
  name: string;
  version?: number;
  stores: IdbStoreItem[];
  truncated?: boolean;
  /** Why the recorder could not read the database. */
  error?: string;
};

export type StorageAreaState<T> = {
  items: T[];
  coverage: StorageCoverage;
  /** The latest snapshot at or before the moment, if any (otherwise only operations are known). */
  snapshotEventId?: string;
  snapshotMono?: number;
  /** The item count the last snapshot reported (may exceed `items` when truncated or names-only). */
  reportedCount?: number;
  truncated: boolean;
};

/** Storage as the page saw it at one moment, rebuilt from snapshots and the operations after them. */
export type StorageStateAt = {
  mono: number;
  local: StorageAreaState<StorageItem>;
  session: StorageAreaState<StorageItem>;
  cookie: StorageAreaState<CookieItem>;
  idb: StorageAreaState<IdbDatabaseItem>;
};

export type StorageChangeArea = StorageArea | "cache" | "sw";

/** One row of the storage log: an operation, or a snapshot of a whole area. */
export type StorageChange = {
  eventId: string;
  mono: number;
  area: StorageChangeArea;
  /** `setItem`, `removeItem`, `clear`, `open`, …, or `snapshot`. */
  op: string;
  key?: string;
  value?: string;
  valueLength?: number;
  valueTruncated?: boolean;
  /**
   * The key's value before the operation: a string, `null` when the key did not exist, absent when
   * the archive cannot tell (no earlier snapshot, or the value was not kept).
   */
  previousValue?: string | null;
  /** The recorder kept the key or value out (profile or redaction). */
  redacted: boolean;
  /** Items in a snapshot. */
  count?: number;
  reason?: string;
};

const AREA_BY_TYPE: Readonly<Record<string, StorageChangeArea>> = {
  "storage.local.snapshot": "local",
  "storage.local.op": "local",
  "storage.session.op": "session",
  "storage.cookie.snapshot": "cookie",
  "storage.idb.snapshot": "idb",
  "storage.idb.op": "idb",
  "storage.cache.op": "cache",
  "storage.sw.lifecycle": "sw"
};

type SnapshotInfo = { eventId: string; mono: number; count?: number; truncated: boolean };

/**
 * Replay accumulator of one key/value area (localStorage or sessionStorage). Its map is private to
 * one replay and updated in place, so a long op log stays linear; results copy it out.
 */
type KeyValueArea = {
  items: Map<string, StorageItem>;
  /** The last snapshot of the area (the item set is complete after it). */
  snapshot: SnapshotInfo | null;
  hasValues: boolean;
  hasNames: boolean;
};

type Replay = {
  local: KeyValueArea;
  session: KeyValueArea;
  cookie: StorageAreaState<CookieItem>;
  idb: StorageAreaState<IdbDatabaseItem>;
};

function createKeyValueArea(): KeyValueArea {
  return { items: new Map(), snapshot: null, hasValues: false, hasNames: false };
}

function createReplay(): Replay {
  return {
    local: createKeyValueArea(),
    session: createKeyValueArea(),
    cookie: { items: [], coverage: "none", truncated: false },
    idb: { items: [], coverage: "none", truncated: false }
  };
}

/** Whether an event belongs to the storage log. */
export function isStorageEvent(event: WebBlackboxEvent): boolean {
  return readArea(event) !== null;
}

function readArea(event: WebBlackboxEvent): StorageChangeArea | null {
  return Object.hasOwn(AREA_BY_TYPE, event.type) ? (AREA_BY_TYPE[event.type] ?? null) : null;
}

/**
 * Storage at `mono`: the latest snapshot of each area at or before it, with the later operations
 * applied in order. Events must be in time order (the archive order); non-storage events are
 * ignored.
 */
export function buildStorageStateAt(
  events: readonly WebBlackboxEvent[],
  mono: number
): StorageStateAt {
  let replay = createReplay();

  for (const event of events) {
    if (event.mono > mono) {
      break;
    }

    replay = applyEvent(replay, event);
  }

  return {
    mono,
    local: finishKeyValueArea(replay.local),
    session: finishKeyValueArea(replay.session),
    cookie: replay.cookie,
    idb: replay.idb
  };
}

/** The storage log in time order, each operation with the key's previous value when known. */
export function buildStorageChanges(events: readonly WebBlackboxEvent[]): StorageChange[] {
  let replay = createReplay();
  const changes: StorageChange[] = [];

  for (const event of events) {
    const area = readArea(event);

    if (!area) {
      continue;
    }

    changes.push(describeChange(replay, event, area));
    replay = applyEvent(replay, event);
  }

  return changes;
}

function describeChange(
  replay: Replay,
  event: WebBlackboxEvent,
  area: StorageChangeArea
): StorageChange {
  const data = asRecord(event.data) ?? {};
  const isSnapshot = event.type.endsWith(".snapshot");
  const key = asString(data.key) ?? asString(data.name);
  const value = typeof data.value === "string" ? data.value : undefined;
  const valueLength = asCount(data.valueLength) ?? value?.length;
  const keyValueArea = area === "local" || area === "session" ? replay[area] : null;
  const previous =
    keyValueArea && key && !isSnapshot ? readPreviousValue(keyValueArea, key) : undefined;
  const count = asCount(data.count);
  const reason = asString(data.reason);

  return {
    eventId: event.id,
    mono: event.mono,
    area,
    op: isSnapshot ? "snapshot" : (asString(data.op) ?? asString(data.phase) ?? "op"),
    ...(key ? { key } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(valueLength !== undefined ? { valueLength } : {}),
    ...(data.valueTruncated === true ? { valueTruncated: true } : {}),
    ...(previous !== undefined ? { previousValue: previous } : {}),
    redacted: data.redacted === true || data.keyRedacted === true,
    ...(count !== undefined ? { count } : {}),
    ...(reason ? { reason } : {})
  };
}

function applyEvent(replay: Replay, event: WebBlackboxEvent): Replay {
  const data = asRecord(event.data);

  if (!data) {
    return replay;
  }

  switch (event.type) {
    case "storage.local.snapshot":
      return { ...replay, local: applyKeyValueSnapshot(replay.local, event, data) };
    case "storage.local.op":
      return { ...replay, local: applyKeyValueOp(replay.local, event, data) };
    case "storage.session.op":
      return { ...replay, session: applyKeyValueOp(replay.session, event, data) };
    case "storage.cookie.snapshot":
      return { ...replay, cookie: readCookieSnapshot(event, data) };
    case "storage.idb.snapshot":
      return { ...replay, idb: readIdbSnapshot(event, data) };
    case "storage.idb.op":
      return { ...replay, idb: applyIdbOp(replay.idb, data) };
    default:
      return replay;
  }
}

function applyKeyValueSnapshot(
  area: KeyValueArea,
  event: WebBlackboxEvent,
  data: Record<string, unknown>
): KeyValueArea {
  const items = new Map<string, StorageItem>();
  let hasValues = false;

  for (const raw of Array.isArray(data.entries) ? data.entries : []) {
    const row = asRecord(raw);
    const key = asString(row?.key);

    if (row && key) {
      items.set(key, toItem(key, row, event));
      hasValues ||= typeof row.value === "string";
    }
  }

  for (const name of readStringList(data.names ?? data.keys)) {
    if (!items.has(name)) {
      items.set(name, { key: name, updatedEventId: event.id, updatedMono: event.mono });
    }
  }

  return {
    items,
    snapshot: {
      eventId: event.id,
      mono: event.mono,
      ...(asCount(data.count) !== undefined ? { count: asCount(data.count) } : {}),
      truncated: data.truncated === true
    },
    hasValues: area.hasValues || hasValues,
    hasNames: area.hasNames || items.size > 0
  };
}

function applyKeyValueOp(
  area: KeyValueArea,
  event: WebBlackboxEvent,
  data: Record<string, unknown>
): KeyValueArea {
  const op = asString(data.op);
  const key = asString(data.key);

  if (op === "clear") {
    return { ...area, items: new Map() };
  }

  if (!key || (op !== "setItem" && op !== "removeItem")) {
    return area;
  }

  // In place: the map belongs to this replay only (see `KeyValueArea`).
  if (op === "removeItem") {
    area.items.delete(key);
  } else {
    area.items.set(key, toItem(key, data, event));
  }

  return {
    ...area,
    hasNames: true,
    hasValues: area.hasValues || (op === "setItem" && typeof data.value === "string")
  };
}

function readPreviousValue(area: KeyValueArea, key: string): string | null | undefined {
  const item = area.items.get(key);

  if (item) {
    return item.value;
  }

  // Without a complete snapshot an unseen key may have existed before the recording started.
  return area.snapshot && !area.snapshot.truncated ? null : undefined;
}

function toItem(key: string, row: Record<string, unknown>, event: WebBlackboxEvent): StorageItem {
  const value = typeof row.value === "string" ? row.value : undefined;
  const valueLength = asCount(row.valueLength) ?? value?.length;

  return {
    key,
    ...(value !== undefined ? { value } : {}),
    ...(valueLength !== undefined ? { valueLength } : {}),
    ...(row.valueTruncated === true ? { valueTruncated: true } : {}),
    updatedEventId: event.id,
    updatedMono: event.mono
  };
}

function finishKeyValueArea(area: KeyValueArea): StorageAreaState<StorageItem> {
  const items = [...area.items.values()].sort((left, right) => left.key.localeCompare(right.key));
  const snapshot = area.snapshot;

  return {
    items,
    coverage: readCoverage(area.hasValues, area.hasNames || items.length > 0, snapshot?.count),
    ...(snapshot ? { snapshotEventId: snapshot.eventId, snapshotMono: snapshot.mono } : {}),
    ...(snapshot?.count !== undefined ? { reportedCount: snapshot.count } : {}),
    truncated: snapshot?.truncated ?? false
  };
}

function readCookieSnapshot(
  event: WebBlackboxEvent,
  data: Record<string, unknown>
): StorageAreaState<CookieItem> {
  const cookies = (Array.isArray(data.cookies) ? data.cookies : []).flatMap(readCookie);
  const items = cookies.length > 0 ? cookies : readStringList(data.names).map((name) => ({ name }));
  const count = asCount(data.count);

  return {
    items,
    coverage: readCoverage(
      cookies.some((cookie) => cookie.value !== undefined),
      items.length > 0,
      count
    ),
    snapshotEventId: event.id,
    snapshotMono: event.mono,
    ...(count !== undefined ? { reportedCount: count } : {}),
    truncated: data.truncated === true
  };
}

function readCookie(raw: unknown): CookieItem[] {
  const row = asRecord(raw);
  const name = asString(row?.name);

  if (!row || !name) {
    return [];
  }

  return [
    {
      name,
      ...(typeof row.value === "string" ? { value: row.value } : {}),
      ...(row.valueTruncated === true ? { valueTruncated: true } : {}),
      ...optionalString("domain", row.domain),
      ...optionalString("path", row.path),
      ...(typeof row.httpOnly === "boolean" ? { httpOnly: row.httpOnly } : {}),
      ...(typeof row.secure === "boolean" ? { secure: row.secure } : {}),
      ...optionalString("sameSite", row.sameSite),
      ...(typeof row.expires === "number" && row.expires > 0 ? { expires: row.expires } : {})
    }
  ];
}

function readIdbSnapshot(
  event: WebBlackboxEvent,
  data: Record<string, unknown>
): StorageAreaState<IdbDatabaseItem> {
  const databases = (Array.isArray(data.databases) ? data.databases : []).flatMap(readDatabase);
  const items =
    databases.length > 0
      ? databases
      : readStringList(data.databaseNames ?? data.names).map((name) => ({ name, stores: [] }));
  const count = asCount(data.count);
  const hasRecords = databases.some((database) =>
    database.stores.some((store) => store.records.length > 0)
  );

  return {
    items,
    coverage: readCoverage(hasRecords, items.length > 0, count),
    snapshotEventId: event.id,
    snapshotMono: event.mono,
    ...(count !== undefined ? { reportedCount: count } : {}),
    truncated: data.truncated === true
  };
}

function readDatabase(raw: unknown): IdbDatabaseItem[] {
  const row = asRecord(raw);
  const name = asString(row?.name);

  if (!row || !name) {
    return [];
  }

  const version = asCount(row.version);

  return [
    {
      name,
      ...(version !== undefined ? { version } : {}),
      stores: (Array.isArray(row.stores) ? row.stores : []).flatMap(readIdbStore),
      ...(row.truncated === true ? { truncated: true } : {}),
      ...optionalString("error", row.error)
    }
  ];
}

function readIdbStore(raw: unknown): IdbStoreItem[] {
  const row = asRecord(raw);
  const name = asString(row?.name);

  if (!row || !name) {
    return [];
  }

  const records = (Array.isArray(row.records) ? row.records : []).flatMap(
    (record): IdbRecordItem[] => {
      const item = asRecord(record);

      return item && typeof item.key === "string" && typeof item.value === "string"
        ? [
            {
              key: item.key,
              value: item.value,
              ...(item.valueTruncated === true ? { valueTruncated: true } : {})
            }
          ]
        : [];
    }
  );

  return [
    {
      name,
      count: asCount(row.count) ?? records.length,
      records,
      ...(row.truncated === true ? { truncated: true } : {})
    }
  ];
}

function applyIdbOp(
  state: StorageAreaState<IdbDatabaseItem>,
  data: Record<string, unknown>
): StorageAreaState<IdbDatabaseItem> {
  const name = asString(data.name);

  if (asString(data.op) !== "open" || !name || state.items.some((item) => item.name === name)) {
    return state;
  }

  const version = asCount(data.version);

  return {
    ...state,
    items: [...state.items, { name, ...(version !== undefined ? { version } : {}), stores: [] }],
    coverage: state.coverage === "values" ? "values" : "names"
  };
}

function readCoverage(
  hasValues: boolean,
  hasNames: boolean,
  count: number | undefined
): StorageCoverage {
  if (hasValues) {
    return "values";
  }

  if (hasNames) {
    return "names";
  }

  return count !== undefined ? "counts" : "none";
}

function optionalString<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
  return typeof value === "string" && value.length > 0
    ? ({ [key]: value } as Record<K, string>)
    : {};
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && item !== ""))]
    : [];
}

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
