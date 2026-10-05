import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { STORAGE_VALUE_MAX_CHARS } from "./capture-scope.js";
import { IDB_SNAPSHOT_MAX_RECORDS, readIndexedDbSnapshot } from "./indexeddb-snapshot.js";

function seed(
  factory: IDBFactory,
  name: string,
  stores: Record<string, Array<{ id: number } & Record<string, unknown>>>
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);

    request.onupgradeneeded = () => {
      for (const store of Object.keys(stores)) {
        request.result.createObjectStore(store, { keyPath: "id" });
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const tx = database.transaction(Object.keys(stores), "readwrite");

      for (const [store, rows] of Object.entries(stores)) {
        for (const row of rows) {
          tx.objectStore(store).put(row);
        }
      }

      tx.oncomplete = () => {
        database.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

describe("readIndexedDbSnapshot", () => {
  it("reads records of every store as JSON text", async () => {
    const factory = new IDBFactory();
    await seed(factory, "lobby-cache", {
      tables: [
        { id: 1, name: "Table 1", seats: 4 },
        { id: 2, name: "Table 2", seats: 5 }
      ],
      settings: [{ id: 1, theme: "dark" }]
    });

    const snapshot = await readIndexedDbSnapshot(factory, await factory.databases());

    expect(snapshot.truncated).toBe(false);
    expect(snapshot.databases).toEqual([
      {
        name: "lobby-cache",
        version: 1,
        stores: [
          {
            name: "settings",
            count: 1,
            records: [{ key: "1", value: '{"id":1,"theme":"dark"}' }]
          },
          {
            name: "tables",
            count: 2,
            records: [
              { key: "1", value: '{"id":1,"name":"Table 1","seats":4}' },
              { key: "2", value: '{"id":2,"name":"Table 2","seats":5}' }
            ]
          }
        ]
      }
    ]);
  });

  it("bounds records per store and caps long values", async () => {
    const factory = new IDBFactory();
    await seed(factory, "big", {
      rows: Array.from({ length: IDB_SNAPSHOT_MAX_RECORDS + 5 }, (_, index) => ({
        id: index,
        blob: "x".repeat(index === 0 ? STORAGE_VALUE_MAX_CHARS * 2 : 4)
      }))
    });

    const snapshot = await readIndexedDbSnapshot(factory, await factory.databases());
    const database = snapshot.databases[0];
    const store = database?.stores[0];

    expect(store?.count).toBe(IDB_SNAPSHOT_MAX_RECORDS + 5);
    expect(store?.records).toHaveLength(IDB_SNAPSHOT_MAX_RECORDS);
    expect(store?.truncated).toBe(true);
    expect(store?.records[0]?.valueTruncated).toBe(true);
    expect(store?.records[0]?.value.length).toBe(STORAGE_VALUE_MAX_CHARS);
    expect(database?.truncated).toBe(true);
  });

  it("never creates a database that is listed but gone", async () => {
    const factory = new IDBFactory();

    const snapshot = await readIndexedDbSnapshot(factory, [{ name: "vanished", version: 3 }]);

    expect(snapshot.databases[0]).toMatchObject({ name: "vanished", stores: [] });
    expect(snapshot.databases[0]?.error).toBeDefined();
    expect((await factory.databases()).map((row) => row.name)).not.toContain("vanished");
  });
});
