import type { NetworkWaterfallEntry, RealtimeStream } from "@webblackbox/player-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  notCapturedSummary,
  requestBodyAvailability,
  responseBodyAvailability
} from "./availability.js";
import {
  bodyCopyText,
  decodeBody,
  decodeText,
  maskBody,
  parseFormPairs,
  queryPairs
} from "./body.js";
import { decodeBase64, formatPartialJson, hexRow, hexRowCount } from "./formatters.js";
import {
  allContainerPaths,
  childPath,
  defaultExpandedPaths,
  flattenJson,
  kindOf,
  scalarText
} from "./json-tree-model.js";
import { networkMessages, type NetworkMessageKey } from "./messages.js";
import { REPLAY_TIMEOUT_MS, replayRequest } from "./replay.js";
import {
  buildNetworkModel,
  buildNetworkView,
  findSlowestRow,
  followIndex,
  rowOfSelection,
  selectionOfRow,
  socketPath,
  socketRowId,
  type NetworkFilters,
  type NetworkSort
} from "./rows.js";

const t = (key: NetworkMessageKey, values?: Record<string, string | number>) =>
  networkMessages.translate("en", key, values);
const bytes = (value: number) => `${value} B`;
const BY_START: NetworkSort = { key: "start", direction: "asc" };

function entry(patch: Partial<NetworkWaterfallEntry>): NetworkWaterfallEntry {
  return {
    reqId: "r1",
    url: "https://app.example.test/api/a",
    method: "GET",
    status: 200,
    mimeType: "application/json",
    startMono: 1_000,
    endMono: 1_100,
    durationMs: 100,
    startWallTime: 0,
    endWallTime: 0,
    failed: false,
    requestHeaders: {},
    responseHeaders: {},
    eventIds: [`${patch.reqId ?? "r1"}-e1`],
    ...patch
  };
}

function stream(patch: Partial<RealtimeStream>): RealtimeStream {
  return {
    streamId: "ws1",
    protocol: "ws",
    url: "wss://app.example.test/hubs?access_token=abc",
    openMono: 1_050,
    openEventId: "open-1",
    firstMono: 1_050,
    lastMono: 2_000,
    messages: [
      {
        eventId: "frame-1",
        eventType: "network.ws.frame",
        protocol: "ws",
        mono: 1_060,
        t: 0,
        streamId: "ws1",
        payloadPreview: "x"
      }
    ],
    sent: 0,
    received: 1,
    sentBytes: 0,
    receivedBytes: 1,
    truncated: 1,
    format: "text",
    ...patch
  };
}

const SESSION = { origin: "https://app.example.test", minMono: 1_000, durationMono: 2_000 };
const FILTERS: NetworkFilters = {
  query: "",
  type: "all",
  failedOnly: false,
  notCapturedOnly: false,
  hideThirdParty: true
};

describe("network rows", () => {
  const waterfall = [
    entry({ reqId: "r1" }),
    entry({
      reqId: "r2",
      url: "https://tracker.example.net/collect",
      startMono: 1_020,
      failed: true,
      status: undefined,
      errorText: "net::ERR_ADDRESS_INVALID"
    }),
    entry({
      reqId: "r3",
      url: "https://app.example.test/app.js",
      mimeType: "application/javascript",
      startMono: 1_200,
      durationMs: 900,
      responseBodySkip: { reason: "too-large", size: 5_000, limit: 1_000 }
    }),
    entry({
      reqId: "sse1",
      url: "https://app.example.test/events",
      mimeType: "text/event-stream",
      startMono: 1_300
    })
  ];
  const sse = stream({
    streamId: "sse1",
    protocol: "sse",
    url: "https://app.example.test/events",
    openMono: undefined,
    openEventId: undefined,
    firstMono: 1_310,
    messages: []
  });
  const model = buildNetworkModel(waterfall, [stream({}), sse], SESSION);
  const ids = (filters: NetworkFilters, sort: NetworkSort = BY_START) =>
    buildNetworkView(model, filters, sort, "en").rows.map((row) => row.id);

  it("merges requests and sockets by start time; an SSE stream rides on its request", () => {
    expect(model.rows.map((row) => row.id)).toEqual(["r1", "r2", "ws:ws1", "r3", "sse1"]);
    const sseRow = model.rowById.get("sse1");
    expect(sseRow?.kind === "http" ? sseRow.stream?.streamId : null).toBe("sse1");
  });

  it("maps selections to rows and back", () => {
    const socket = model.rowById.get(socketRowId(stream({})));
    expect(rowOfSelection(model, { kind: "request", id: "r3" })?.id).toBe("r3");
    expect(rowOfSelection(model, { kind: "event", id: "frame-1" })).toBe(socket);
    expect(rowOfSelection(model, { kind: "event", id: "r1-e1" })?.id).toBe("r1");
    expect(rowOfSelection(model, { kind: "event", id: "unknown" })).toBeNull();
    expect(rowOfSelection(model, { kind: "action", id: "A-1" })).toBeNull();
    expect(rowOfSelection(model, null)).toBeNull();
    expect(socket ? selectionOfRow(socket) : null).toEqual({ kind: "event", id: "open-1" });
  });

  it("keeps only the rows that start inside the timeline range", () => {
    const all = buildNetworkView(model, FILTERS, BY_START, "en").rows;
    const second = all[1];
    const range = second ? { startMono: second.startMono, endMono: second.startMono + 1 } : null;

    expect(ids({ ...FILTERS, range })).toEqual(second ? [second.id] : []);
    expect(ids({ ...FILTERS, range: null })).toEqual(all.map((row) => row.id));
  });

  it("filters third-party, types, failures and not-captured bodies, with chip counts", () => {
    const view = buildNetworkView(model, FILTERS, BY_START, "en");
    expect(view.rows.map((row) => row.id)).toEqual(["r1", "ws:ws1", "r3", "sse1"]);
    expect(view.hiddenThirdParty).toBe(1);
    expect(view.counts).toMatchObject({
      all: 4,
      fetch: 1,
      script: 1,
      ws: 1,
      failed: 0,
      notCaptured: 2
    });
    expect(ids({ ...FILTERS, type: "ws" })).toEqual(["ws:ws1"]);
    expect(ids({ ...FILTERS, hideThirdParty: false, failedOnly: true })).toEqual(["r2"]);
    expect(ids({ ...FILTERS, notCapturedOnly: true })).toEqual(["ws:ws1", "r3"]);
    expect(ids({ ...FILTERS, query: "hubs" })).toEqual(["ws:ws1"]);
    expect(ids({ ...FILTERS, query: "app.js" })).toEqual(["r3"]);
  });

  it("sorts by any column, stable for ties", () => {
    const all = { ...FILTERS, hideThirdParty: false };
    expect(ids(all, { key: "time", direction: "desc" })[0]).toBe("ws:ws1");
    expect(ids(all, { key: "status", direction: "asc" })[0]).toBe("r2");
    expect(ids(all, { key: "start", direction: "desc" })[0]).toBe("sse1");

    for (const key of ["name", "method", "size", "type", "initiator"] as const) {
      expect(ids(all, { key, direction: "asc" })).toHaveLength(5);
    }
  });

  it("names sockets by their path, not their token query", () => {
    expect(socketPath(stream({}))).toEqual({ path: "/hubs", host: "app.example.test" });
    expect(socketPath(stream({ url: undefined }))).toBeNull();
    expect(socketPath(stream({ url: "not a url?x=1" }))).toEqual({ path: "not a url", host: "" });
  });

  it("finds the follow target and the slowest request", () => {
    expect(followIndex(model.rows, 900)).toBe(-1);
    expect(followIndex(model.rows, 1_250)).toBe(3);
    expect(findSlowestRow(model.rows)?.id).toBe("r3");
    expect(findSlowestRow([])).toBeNull();
  });
});

describe("body availability and reasons", () => {
  it("tells captured, cut, skipped, missing and no-body responses apart", () => {
    expect(responseBodyAvailability(entry({ responseBodyHash: "h" }))).toEqual({
      state: "captured",
      truncated: false
    });
    expect(
      responseBodyAvailability(entry({ responseBodyHash: "h", responseBodyTruncated: true }))
    ).toEqual({ state: "captured", truncated: true });
    expect(
      responseBodyAvailability(entry({ responseBodySkip: { reason: "not-retained" } })).state
    ).toBe("skipped");
    expect(responseBodyAvailability(entry({})).state).toBe("missing");
    expect(responseBodyAvailability(entry({ status: 204 })).state).toBe("none");
    expect(responseBodyAvailability(entry({ status: 302 })).state).toBe("none");
    expect(responseBodyAvailability(entry({ failed: true })).state).toBe("none");
    expect(responseBodyAvailability(entry({ method: "HEAD" })).state).toBe("none");
  });

  it("tells request bodies apart", () => {
    expect(
      requestBodyAvailability(entry({ requestBodyText: "a=1", requestBodyTruncated: true }))
    ).toEqual({ state: "captured", truncated: true });
    expect(requestBodyAvailability(entry({ requestBodySkipReason: "unavailable" }))).toEqual({
      state: "skipped",
      skip: { reason: "unavailable" }
    });
    expect(requestBodyAvailability(entry({ requestHasBody: true })).state).toBe("missing");
    expect(requestBodyAvailability(entry({})).state).toBe("none");
  });

  it("writes one reason per skip kind", () => {
    const reason = (skip: NonNullable<NetworkWaterfallEntry["responseBodySkip"]>, mime?: string) =>
      notCapturedSummary(entry({ responseBodySkip: skip, mimeType: mime }), t, bytes);

    expect(reason({ reason: "too-large", size: 5_000, limit: 1_000 })).toBe(
      "Body not captured: too large (5000 B, limit 1000 B)"
    );
    expect(reason({ reason: "too-large" })).toContain("larger than the capture limit");
    expect(reason({ reason: "mime-not-allowed" }, "text/csv")).toContain("does not keep text/csv");
    expect(reason({ reason: "mime-not-allowed" }, "")).toContain("this type");
    expect(reason({ reason: "fetch-failed", detail: "No data" })).toContain("(No data)");

    for (const name of [
      "filtered",
      "session-limit",
      "backlog",
      "not-retained",
      "unavailable",
      "empty"
    ] as const) {
      expect(reason({ reason: name })).toMatch(/^Body not captured: \w/);
    }

    expect(notCapturedSummary(entry({ requestBodySkipReason: "unavailable" }), t, bytes)).toContain(
      "does not expose"
    );
    expect(notCapturedSummary(entry({}), t, bytes)).toBeNull();
  });
});

describe("bodies", () => {
  const encode = (text: string) => new TextEncoder().encode(text);

  it("decodes JSON, text, images and binary", () => {
    expect(decodeBody(encode(`{"a":1}`), "application/json; charset=utf-8")).toMatchObject({
      kind: "json",
      value: { a: 1 }
    });
    expect(decodeBody(encode("body{}"), "text/css")).toMatchObject({
      kind: "text",
      language: "css"
    });
    expect(decodeBody(encode("<p>"), "text/html")).toMatchObject({ language: "html" });
    expect(decodeBody(encode("x()"), "application/javascript")).toMatchObject({
      language: "javascript"
    });
    expect(decodeBody(encode("<a/>"), "image/svg+xml")).toMatchObject({ language: "xml" });
    expect(decodeBody(new Uint8Array([137, 80]), "image/png").kind).toBe("image");
    expect(decodeBody(new Uint8Array([0, 1, 2]), "application/octet-stream").kind).toBe("binary");
    expect(decodeBody(encode("plain words"), "").kind).toBe("text");
    expect(decodeBody(new Uint8Array(), "text/plain").kind).toBe("empty");
    expect(decodeText(`{"broken"`, "json")).toMatchObject({ kind: "text", language: "plain" });
    expect(decodeText("")).toEqual({ kind: "empty" });
  });

  it("masks secrets and copies text", () => {
    expect(maskBody(decodeText(`{"token":"abc","n":1}`))).toMatchObject({
      kind: "json",
      value: { token: "***", n: 1 }
    });
    const masked = maskBody(
      decodeText(
        `{"token": 12345, "password": "my pass phrase", "user": {"apiKey": null, "cookie": {"a": "b"}},` +
          ` "note": "Bearer abc.def", "list": [{"secret": true}], "id": 7}`
      )
    );
    expect(masked).toEqual({
      kind: "json",
      text: expect.any(String),
      value: {
        token: "***",
        password: "***",
        user: { apiKey: "***", cookie: "***" },
        note: "Bearer ***",
        list: [{ secret: "***" }],
        id: 7
      }
    });
    expect(masked.kind === "json" && JSON.parse(masked.text)).toEqual(
      masked.kind === "json" && masked.value
    );
    expect(maskBody(decodeText(`{\n  "token": "x"\n}`))).toMatchObject({
      text: `{\n  "token": "***"\n}`
    });
    expect(maskBody(decodeText("Bearer abc.def"))).toMatchObject({
      kind: "text",
      text: "Bearer ***"
    });
    expect(bodyCopyText(decodeText(`{"a":1}`))).toBe('{\n  "a": 1\n}');
    expect(bodyCopyText({ kind: "binary", mime: "x", bytes: new Uint8Array() })).toBeNull();
  });

  it("reads form bodies and query strings", () => {
    expect(parseFormPairs("a=1&b=two+words&c&bad=%E0")).toEqual([
      ["a", "1"],
      ["b", "two words"],
      ["c", ""],
      ["bad", "%E0"]
    ]);
    expect(queryPairs("https://a.test/x?q=1&r=2")).toEqual([
      ["q", "1"],
      ["r", "2"]
    ]);
    expect(queryPairs("::")).toEqual([]);
  });
});

describe("JSON tree model", () => {
  const value = { user: { name: "Ann", tags: ["a", "b"] }, "odd key": null, n: 1 };

  it("flattens only the open containers", () => {
    const closed = flattenJson(value, new Set());
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ path: "$", kind: "object", childCount: 3, expanded: false });

    const rows = flattenJson(value, new Set(["$", "$.user"]));
    expect(rows.map((row) => row.path)).toEqual([
      "$",
      "$.user",
      "$.user.name",
      "$.user.tags",
      '$["odd key"]',
      "$.n"
    ]);
    expect(rows.find((row) => row.path === "$.user.tags")).toMatchObject({
      depth: 2,
      expanded: false
    });
  });

  it("opens the first levels by default and expands all within a budget", () => {
    expect([...defaultExpandedPaths(value)]).toEqual(["$", "$.user"]);
    const big = { big: Array.from({ length: 60 }, (_, index) => index) };
    expect(defaultExpandedPaths(big).has("$.big")).toBe(false);
    expect([...allContainerPaths(value, 10)]).toEqual(["$", "$.user", "$.user.tags"]);
    expect(allContainerPaths(value, 1).size).toBe(1);
  });

  it("names kinds, paths and scalar text", () => {
    expect(
      [[], null, undefined, 1, "s", true, () => 1].map((item) => kindOf(item as unknown))
    ).toEqual(["array", "null", "null", "number", "string", "boolean", "null"]);
    expect(childPath("$", 2)).toBe("$[2]");
    expect(scalarText({ kind: "string", value: 'a"b' })).toBe('"a\\"b"');
    expect(scalarText({ kind: "null", value: null })).toBe("null");
  });
});

describe("formatters", () => {
  it("dumps bytes as hex rows", () => {
    const data = new TextEncoder().encode("Hello, hex view!\u0001");
    expect(hexRowCount(data.byteLength)).toBe(2);
    expect(hexRow(data, 0)).toEqual({
      offset: "00000000",
      hex: "48 65 6c 6c 6f 2c 20 68 65 78 20 76 69 65 77 21",
      ascii: "Hello, hex view!"
    });
    expect(hexRow(data, 1)).toEqual({ offset: "00000010", hex: "01", ascii: "." });
  });

  it("decodes base64 previews", () => {
    expect(decodeBase64("AAEC")).toEqual(new Uint8Array([0, 1, 2]));
    expect(decodeBase64("not base64!")).toBeNull();
    expect(decodeBase64("")).toBeNull();
  });

  it("re-indents JSON that stops mid-way", () => {
    expect(formatPartialJson(`{"a":[1,2],"b":{},"s":"x,{y}","c":{"d":`)).toBe(
      '{\n  "a": [\n    1,\n    2\n  ],\n  "b": {},\n  "s": "x,{y}",\n  "c": {\n    "d": '
    );
    expect(formatPartialJson(`["esc\\"aped",`)).toBe('[\n  "esc\\"aped",\n  ');
    expect(formatPartialJson("{")).toBe("{");
  });
});

describe("replayRequest", () => {
  const deps = (response: Response | Error, hash = "h1") => ({
    fetch: vi.fn(async (...call: [string, RequestInit]) => {
      void call;
      if (response instanceof Error) {
        throw response;
      }

      return response;
    }),
    now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(52),
    hash: vi.fn(async (bytes: Uint8Array<ArrayBuffer>) => {
      void bytes;
      return hash;
    }),
    timeout: vi.fn(() => undefined)
  });

  it("sends the recorded request and compares status and body", async () => {
    const replay = deps(new Response("ok", { status: 201, statusText: "Created" }));
    const outcome = await replayRequest(
      entry({
        method: "post",
        requestBodyText: "a=1",
        requestHeaders: { cookie: "x", "x-id": "7" },
        responseBodyHash: "h1"
      }),
      replay
    );

    expect(outcome).toEqual({
      ok: true,
      status: 201,
      statusText: "Created",
      durationMs: 42,
      bodyBytes: 2,
      bodyMatches: true
    });
    const init = replay.fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("a=1");
    expect((init?.headers as Headers).has("cookie")).toBe(false);
    expect((init?.headers as Headers).get("x-id")).toBe("7");
    expect(init?.credentials).toBe("omit");
    expect(init?.referrerPolicy).toBe("no-referrer");
    expect(replay.timeout).toHaveBeenCalledWith(REPLAY_TIMEOUT_MS);
  });

  it("hashes the answer's bytes, not its decoded text", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff]);
    const replay = deps(new Response(bytes));
    await replayRequest(entry({ responseBodyHash: "h1" }), replay);

    expect([...(replay.hash.mock.calls[0]?.[0] ?? [])]).toEqual([...bytes]);
  });

  it("does not compare against a cut recording", async () => {
    const replay = deps(new Response("ok"));
    const outcome = await replayRequest(
      entry({ responseBodyHash: "h1", responseBodyTruncated: true }),
      replay
    );

    expect(outcome).toMatchObject({ ok: true, bodyMatches: null });
    expect(replay.hash).not.toHaveBeenCalled();
  });

  it("refuses to send a request body that was cut or not kept", async () => {
    const cases = [
      { method: "POST", requestBodyText: "a=", requestBodyTruncated: true as const },
      { method: "PUT", requestBodySkipReason: "too-large" as const },
      { method: "POST", requestHasBody: true as const }
    ];

    for (const fields of cases) {
      const replay = deps(new Response("x"));
      expect(await replayRequest(entry(fields), replay)).toEqual({
        ok: false,
        refused: "request-body-incomplete"
      });
      expect(replay.fetch).not.toHaveBeenCalled();
    }

    const get = deps(new Response("x"));
    expect(await replayRequest(entry({ requestHasBody: true }), get)).toMatchObject({ ok: true });
  });

  it("reports no comparison without a recorded body, and failures", async () => {
    expect(await replayRequest(entry({}), deps(new Response("x")))).toMatchObject({
      ok: true,
      bodyMatches: null
    });
    expect(await replayRequest(entry({}), deps(new Error("blocked")))).toEqual({
      ok: false,
      error: "blocked"
    });
  });
});
