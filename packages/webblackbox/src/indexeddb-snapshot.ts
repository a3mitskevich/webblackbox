import { capStorageValue, STORAGE_SNAPSHOT_MAX_VALUE_CHARS } from "./capture-scope.js";

/** Databases read for one `indexedDb: allow` snapshot. */
export const IDB_SNAPSHOT_MAX_DATABASES = 10;
/** Object stores read per database. */
export const IDB_SNAPSHOT_MAX_STORES = 20;
/** Records read per object store (the first ones in key order). */
export const IDB_SNAPSHOT_MAX_RECORDS = 50;
/** Longest wait for one database to open; a database blocked by an upgrade is skipped. */
export const IDB_SNAPSHOT_OPEN_TIMEOUT_MS = 1_500;

export type IdbSnapshotRecord = { key: string; value: string; valueTruncated?: true };

export type IdbSnapshotStore = {
  name: string;
  count: number;
  records: IdbSnapshotRecord[];
  truncated?: true;
};

export type IdbSnapshotDatabase = {
  name: string;
  version?: number;
  stores: IdbSnapshotStore[];
  truncated?: true;
  /** Why the database could not be read (blocked, failed or timed out). */
  error?: string;
};

export type IdbSnapshot = {
  databases: IdbSnapshotDatabase[];
  truncated: boolean;
};

/**
 * Reads the page's IndexedDB contents for `indexedDb: allow`: up to
 * {@link IDB_SNAPSHOT_MAX_RECORDS} records per store, values as JSON text capped like other
 * storage values, within the shared {@link STORAGE_SNAPSHOT_MAX_VALUE_CHARS} budget. Read-only
 * transactions; every database is closed again and an unreadable one is reported, not thrown.
 */
export async function readIndexedDbSnapshot(
  factory: IDBFactory,
  databases: ReadonlyArray<{ name?: string; version?: number }>
): Promise<IdbSnapshot> {
  const named = databases.filter(
    (row): row is { name: string; version?: number } => typeof row.name === "string"
  );
  const budget = { chars: STORAGE_SNAPSHOT_MAX_VALUE_CHARS };
  const output: IdbSnapshotDatabase[] = [];

  for (const row of named.slice(0, IDB_SNAPSHOT_MAX_DATABASES)) {
    output.push(await readDatabase(factory, row.name, row.version, budget));
  }

  return {
    databases: output,
    truncated: named.length > output.length || output.some((database) => database.truncated)
  };
}

async function readDatabase(
  factory: IDBFactory,
  name: string,
  version: number | undefined,
  budget: { chars: number }
): Promise<IdbSnapshotDatabase> {
  let database: IDBDatabase;

  try {
    database = await openExisting(factory, name);
  } catch (error) {
    return { name, version, stores: [], error: errorText(error) };
  }

  // Never hold up the page's own upgrade: give the connection back at once.
  database.onversionchange = () => database.close();

  try {
    const storeNames = Array.from(database.objectStoreNames);
    const stores: IdbSnapshotStore[] = [];

    for (const storeName of storeNames.slice(0, IDB_SNAPSHOT_MAX_STORES)) {
      stores.push(await readStore(database, storeName, budget));
    }

    const truncated =
      storeNames.length > stores.length || stores.some((store) => store.truncated === true);
    return { name, version: database.version, stores, ...(truncated ? { truncated } : {}) };
  } catch (error) {
    return { name, version, stores: [], error: errorText(error) };
  } finally {
    database.close();
  }
}

/**
 * Opens a database without upgrading it; one that vanished since it was listed is not created.
 * A database that opens after the timeout is closed at once, so it never blocks the page.
 */
function openExisting(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name);
    let settled = false;
    const settle = (callback: () => void): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        callback();
      }
    };
    const timer = setTimeout(
      () => settle(() => reject(new Error("open timed out"))),
      IDB_SNAPSHOT_OPEN_TIMEOUT_MS
    );

    request.onupgradeneeded = () => {
      request.transaction?.abort();
    };
    request.onblocked = () => settle(() => reject(new Error("blocked")));
    request.onerror = () => settle(() => reject(request.error ?? new Error("open failed")));
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }

      settle(() => resolve(request.result));
    };
  });
}

/**
 * Records in key order through a cursor, one at a time, stopping at the record limit or when the
 * shared budget is spent: values past it are never read or serialized.
 */
async function readStore(
  database: IDBDatabase,
  storeName: string,
  budget: { chars: number }
): Promise<IdbSnapshotStore> {
  const store = database.transaction(storeName, "readonly").objectStore(storeName);
  const count = await requestResult(store.count());
  const records: IdbSnapshotRecord[] = [];

  await new Promise<void>((resolve, reject) => {
    const request = store.openCursor();

    request.onerror = () => reject(request.error ?? new Error("cursor failed"));
    request.onsuccess = () => {
      const cursor = request.result;

      if (!cursor || records.length >= IDB_SNAPSHOT_MAX_RECORDS || budget.chars <= 0) {
        resolve();
        return;
      }

      const record = {
        key: capStorageValue(toText(cursor.key)).value,
        ...capStorageValue(toText(cursor.value))
      };
      budget.chars -= record.key.length + record.value.length;
      records.push(record);
      cursor.continue();
    };
  });

  const truncated = count > records.length;
  return { name: storeName, count, records, ...(truncated ? { truncated: true as const } : {}) };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("request failed"));
  });
}

/** JSON text of a structured-clone value; what JSON cannot hold falls back to `String()`. */
function toText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
