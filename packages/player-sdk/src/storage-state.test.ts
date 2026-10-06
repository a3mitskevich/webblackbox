import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import { buildStorageChanges, buildStorageStateAt, isStorageEvent } from "./storage-state.js";

let sequence = 0;

function event(type: string, mono: number, data: unknown): WebBlackboxEvent {
  sequence += 1;
  return {
    v: 1,
    sid: "S-1",
    tab: 1,
    t: 1_000 + mono,
    mono,
    type: type as WebBlackboxEvent["type"],
    id: `E-${sequence}`,
    data
  };
}

const EVENTS = [
  event("storage.local.snapshot", 10, {
    reason: "start",
    count: 2,
    mode: "allow",
    truncated: false,
    entries: [
      { key: "lang", valueLength: 2, value: "en" },
      { key: "token", valueLength: 9, value: "[REDACTED]", valueTruncated: true }
    ]
  }),
  event("storage.cookie.snapshot", 11, {
    count: 3,
    mode: "allow",
    truncated: true,
    cookies: [
      { name: "sid", value: "abc", httpOnly: true, secure: true, sameSite: "Lax", expires: 99 },
      { name: "pref", value: "dark", domain: ".example.test", path: "/", expires: -1 },
      { value: "nameless" }
    ]
  }),
  event("storage.idb.snapshot", 12, {
    count: 1,
    mode: "allow",
    databases: [
      {
        name: "cache",
        version: 3,
        stores: [
          {
            name: "items",
            count: 4,
            truncated: true,
            records: [
              { key: "1", value: '{"id":1}' },
              { key: 2, value: "skip" }
            ]
          }
        ]
      },
      { name: "broken", stores: [], error: "blocked" }
    ]
  }),
  event("network.request", 13, {}),
  event("storage.local.op", 20, { op: "setItem", key: "lang", value: "ru", valueLength: 2 }),
  event("storage.session.op", 21, { op: "setItem", key: "route", value: "#/lobby" }),
  event("storage.local.op", 30, { op: "removeItem", key: "token" }),
  event("storage.local.op", 31, { op: "setItem", key: "new", value: "1" }),
  event("storage.session.op", 32, { op: "setItem", key: "route", value: "#/live" }),
  event("storage.idb.op", 33, { op: "open", name: "other", version: 1 }),
  event("storage.idb.op", 34, { op: "open", name: "cache" }),
  event("storage.session.op", 40, { op: "clear" }),
  event("storage.cache.op", 41, { op: "put" })
];

describe("buildStorageStateAt", () => {
  it("starts from the snapshot and applies later operations up to the moment", () => {
    const state = buildStorageStateAt(EVENTS, 31);

    expect(state.local.items.map((item) => [item.key, item.value])).toEqual([
      ["lang", "ru"],
      ["new", "1"]
    ]);
    expect(state.local).toMatchObject({ coverage: "values", reportedCount: 2, truncated: false });
    expect(state.local.snapshotEventId).toBe(EVENTS[0]?.id);
    expect(state.session.items).toEqual([
      expect.objectContaining({ key: "route", value: "#/lobby", valueLength: 7 })
    ]);
    expect(state.session.snapshotEventId).toBeUndefined();
  });

  it("reads cookie values with their flags and IndexedDB records", () => {
    const state = buildStorageStateAt(EVENTS, 35);

    expect(state.cookie).toMatchObject({ coverage: "values", reportedCount: 3, truncated: true });
    expect(state.cookie.items).toEqual([
      { name: "sid", value: "abc", httpOnly: true, secure: true, sameSite: "Lax", expires: 99 },
      { name: "pref", value: "dark", domain: ".example.test", path: "/" }
    ]);
    expect(state.idb.coverage).toBe("values");
    expect(state.idb.items.map((database) => database.name)).toEqual(["cache", "broken", "other"]);
    expect(state.idb.items[0]?.stores[0]).toEqual({
      name: "items",
      count: 4,
      truncated: true,
      records: [{ key: "1", value: '{"id":1}' }]
    });
    expect(state.idb.items[1]?.error).toBe("blocked");
  });

  it("clears an area and reports names-only and count-only coverage", () => {
    expect(buildStorageStateAt(EVENTS, 50).session.items).toEqual([]);

    const namesOnly = buildStorageStateAt(
      [
        event("storage.cookie.snapshot", 1, { count: 2, names: ["a", "b", "a"] }),
        event("storage.idb.snapshot", 1, { count: 0, databaseNames: [] }),
        event("storage.local.snapshot", 1, { count: 5, names: ["k"] })
      ],
      1
    );

    expect(namesOnly.cookie).toMatchObject({
      coverage: "names",
      items: [{ name: "a" }, { name: "b" }]
    });
    expect(namesOnly.idb.coverage).toBe("counts");
    expect(namesOnly.local.coverage).toBe("names");
    expect(buildStorageStateAt([], 1).local.coverage).toBe("none");
  });
});

describe("buildStorageChanges", () => {
  it("lists snapshots and operations with the previous value when known", () => {
    const changes = buildStorageChanges(EVENTS);

    expect(changes.map((change) => `${change.area}:${change.op}`)).toEqual([
      "local:snapshot",
      "cookie:snapshot",
      "idb:snapshot",
      "local:setItem",
      "session:setItem",
      "local:removeItem",
      "local:setItem",
      "session:setItem",
      "idb:open",
      "idb:open",
      "session:clear",
      "cache:put"
    ]);
    expect(changes[3]).toMatchObject({ key: "lang", value: "ru", previousValue: "en" });
    // No session snapshot: the value before the first write is unknown.
    expect(changes[4]?.previousValue).toBeUndefined();
    expect(changes[5]).toMatchObject({ key: "token", previousValue: "[REDACTED]" });
    expect(changes[6]).toMatchObject({ key: "new", previousValue: null });
    expect(changes[7]).toMatchObject({ key: "route", previousValue: "#/lobby" });
    expect(changes[0]).toMatchObject({ count: 2, reason: "start", redacted: false });
  });

  it("recognises storage events", () => {
    expect(isStorageEvent(EVENTS[0] as WebBlackboxEvent)).toBe(true);
    expect(isStorageEvent(EVENTS[3] as WebBlackboxEvent)).toBe(false);
  });

  it("ignores event types that only match inherited object properties", () => {
    const odd = [event("constructor", 1, {}), event("toString", 2, { key: "x" })];

    expect(odd.some(isStorageEvent)).toBe(false);
    expect(buildStorageChanges(odd)).toEqual([]);
  });

  it("keeps sessionStorage apart and replays a long op log in linear time", () => {
    const ops = Array.from({ length: 50_000 }, (_, index) =>
      event("storage.session.op", index, {
        op: "setItem",
        key: `k${index % 1_000}`,
        value: String(index)
      })
    );
    const startedAt = performance.now();
    const changes = buildStorageChanges(ops);
    const state = buildStorageStateAt(ops, 49_999);

    expect(changes).toHaveLength(50_000);
    expect(changes[1_000]).toMatchObject({ area: "session", key: "k0", previousValue: "0" });
    expect(state.session.items).toHaveLength(1_000);
    expect(state.local.items).toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(3_000);
  });

  it("does not leak operations of one build into the next", () => {
    const ops = [event("storage.local.op", 1, { op: "setItem", key: "a", value: "1" })];

    expect(buildStorageStateAt(ops, 1).local.items).toHaveLength(1);
    expect(buildStorageStateAt([], 1).local.items).toEqual([]);
  });
});
