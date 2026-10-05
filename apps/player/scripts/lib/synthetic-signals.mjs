// R4 signals of the synthetic session: console output at every level, a logged AuthError with a
// full stack and the source map its script embedded at record time, storage writes with values
// (localStorage, sessionStorage, cookies, IndexedDB), other tabs navigating and closing, web vitals,
// long tasks and a performance trace. Added after the R1 events, so their ids do not move.

const MAIN_SCRIPT = "https://app.example.test/static/js/main.js";
const VENDOR_SCRIPT = "https://app.example.test/static/js/vendor.js";
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** The thrown error as Chrome logs it: message line, then V8 frames. */
export const AUTH_ERROR_STACK = [
  "AuthError: casino-user request rejected (401 invalid_token)",
  `    at ensureCasinoUser (${MAIN_SCRIPT}:1:20412)`,
  `    at async LiveGameBootstrap.start (${MAIN_SCRIPT}:1:22100)`,
  "    at async Promise.all (index 2)",
  `    at openLiveGame (${MAIN_SCRIPT}:1:9921)`,
  `    at HttpClient.send (${VENDOR_SCRIPT}:12:88412)`
].join("\n");

const ENSURE_CASINO_USER_SOURCE = [
  'import { http } from "../../shared/http";',
  'import { AuthError, reason } from "./errors";',
  "",
  "export async function ensureCasinoUser(partnerClientId: number, lng: string) {",
  ...Array.from({ length: 48 }, (_, index) => `  // setup ${index + 1}`),
  '  const res = await http.get<CasinoUser>("/gw/bff/users/api/v1.0/casino-user", {',
  "    params: { partnerClientId, lng, generateLogin: true }",
  "  });",
  "  if (res.status === 401) {",
  "    throw new AuthError(`casino-user request rejected (401 ${reason(res)})`);",
  "  }",
  "  return res.data;",
  "}"
];

const BOOTSTRAP_SOURCE = [
  ...Array.from({ length: 109 }, (_, index) => `// bootstrap ${index + 1}`),
  "export class LiveGameBootstrap {",
  "  async start() {",
  "    const [, user] = await Promise.all([this.loadTable(), ensureCasinoUser(this.client, this.lng)]);",
  "    return user;",
  "  }",
  "}"
];

const OPEN_GAME_SOURCE = [
  ...Array.from({ length: 32 }, (_, index) => `// open game ${index + 1}`),
  "export function openLiveGame(id: number) {",
  "  return new LiveGameBootstrap(id).start();",
  "}"
];

function vlq(value) {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";

  do {
    let digit = rest & 31;
    rest >>>= 5;

    if (rest > 0) {
      digit |= 32;
    }

    out += BASE64[digit];
  } while (rest > 0);

  return out;
}

/** A v3 source map of main.js line 1: three positions in three original files. */
export function buildMainScriptSourceMap() {
  // [generated column, source, original line, original column, name] (0-based), column order.
  const segments = [
    [9_920, 2, 33, 2, 2],
    [20_411, 0, 56, 10, 0],
    [22_099, 1, 111, 4, 1]
  ];
  let previous = [0, 0, 0, 0, 0];
  const encoded = segments.map((segment) => {
    const fields = segment.map((value, index) => vlq(value - previous[index]));
    previous = segment;
    return fields.join("");
  });

  return JSON.stringify({
    version: 3,
    file: "main.js",
    sources: [
      "webpack://app/src/live/session/ensure-casino-user.ts",
      "webpack://app/src/live/bootstrap.ts",
      "webpack://app/src/lobby/open-game.ts"
    ],
    sourcesContent: [
      ENSURE_CASINO_USER_SOURCE.join("\n"),
      BOOTSTRAP_SOURCE.join("\n"),
      OPEN_GAME_SOURCE.join("\n")
    ],
    names: ["ensureCasinoUser", "LiveGameBootstrap.start", "openLiveGame"],
    mappings: encoded.join(",")
  });
}

/**
 * Adds the R4 events through the session builder's helpers: `add(offsetMs, type, data, extra)`,
 * `addBlob(mime, bytes)` (returns the hash) and `relatedTab(tabId, origin, path, title)`.
 */
export function addR4Signals({ add, addBlob, relatedTab, origin, appUrl }) {
  const map = new TextEncoder().encode(buildMainScriptSourceMap());
  const mapHash = addBlob("application/json", map);
  const route = (path) => ({ routeContext: { url: `${appUrl}${path}`, source: "history" } });

  add(20, "sys.script", {
    script: MAIN_SCRIPT,
    sourceMap: `${MAIN_SCRIPT}.map`,
    origin: "comment",
    map: { contentHash: mapHash, size: map.byteLength }
  });

  const log = (offsetMs, level, text, extra = {}) =>
    add(offsetMs, "console.entry", {
      source: "cdp.runtime",
      level,
      method: level,
      text,
      args: [extra.arg ?? text],
      ...(extra.stackTop ? { stackTop: extra.stackTop } : {}),
      timestamp: 1_790_000_000_000 + offsetMs
    });

  log(60, "log", "isHiddenTestFeature: false", {
    stackTop: `(anonymous) @ ${VENDOR_SCRIPT}:35:2247`
  });
  log(62, "log", "testDynamicFeatureFlag: true", {
    stackTop: `(anonymous) @ ${VENDOR_SCRIPT}:35:2247`
  });
  log(
    9_460,
    "info",
    "Information: Normalizing '/proxy-game/game' to 'wss://app.example.test/proxy-game/game'.",
    {
      stackTop: `HttpConnection.start @ ${VENDOR_SCRIPT}:11:5120`
    }
  );
  log(
    9_935,
    "info",
    "Information: WebSocket connected to wss://app.example.test/proxy-game/game.",
    {
      stackTop: `WebSocketTransport.connect @ ${VENDOR_SCRIPT}:11:7300`
    }
  );
  log(10_100, "warn", "Deprecated API: GamesTimeTable v1 is going away, use v2", {
    stackTop: `(anonymous) @ ${MAIN_SCRIPT}:0:9000`
  });
  log(11_080, "error", "AuthError: casino-user request rejected (401 invalid_token)", {
    arg: AUTH_ERROR_STACK
  });

  // Storage: cookies and IndexedDB with values (`allow`), localStorage and sessionStorage writes.
  add(320, "storage.cookie.snapshot", {
    reason: "start",
    count: 2,
    truncated: false,
    mode: "allow",
    redacted: false,
    cookies: [
      {
        name: "session",
        value: "eyJhbGci.redacted",
        domain: "app.example.test",
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax"
      },
      { name: "lang", value: "en", domain: "app.example.test", path: "/" }
    ]
  });
  add(340, "storage.idb.snapshot", {
    reason: "start",
    count: 1,
    truncated: false,
    mode: "allow",
    redacted: false,
    databases: [
      {
        name: "game-cache",
        version: 2,
        stores: [
          {
            name: "tables",
            count: 2,
            records: [
              { key: "64", value: '{"id":64,"title":"Live table 64"}' },
              { key: "65", value: '{"id":65,"title":"Live table 65"}' }
            ]
          }
        ]
      }
    ]
  });
  add(9_455, "storage.session.op", {
    op: "setItem",
    redacted: false,
    key: "lastRoute",
    valueLength: 7,
    value: "#/lobby",
    ...route("#/lobby")
  });
  add(9_480, "storage.local.op", {
    op: "setItem",
    redacted: false,
    key: "lobbyState",
    valueLength: 41,
    value: '{"tables":[64,65,66],"filter":"live","v":1}',
    ...route("#/lobby")
  });
  add(10_990, "storage.local.op", {
    op: "setItem",
    redacted: false,
    key: "lobbyState",
    valueLength: 43,
    value: '{"tables":[64,65,66],"filter":"live","v":2,"open":64}',
    ...route("#/live/64")
  });
  add(11_000, "storage.session.op", {
    op: "setItem",
    redacted: false,
    key: "lastRoute",
    valueLength: 9,
    value: "#/live/64",
    ...route("#/live/64")
  });
  add(13_200, "storage.local.op", { op: "removeItem", redacted: false, key: "clientId" });

  // Another tab of the site navigates, then one closes.
  add(5_000, "meta.tabs.change", {
    change: "navigated",
    level: "allow",
    tab: relatedTab(42, "https://admin.example.test", "/users/7", "User 7"),
    openCount: 2
  });
  add(14_000, "meta.tabs.change", {
    change: "closed",
    level: "allow",
    tab: relatedTab(41, origin, "/inbox", "Inbox"),
    openCount: 1
  });

  // Performance: vitals, long tasks and one trace artifact.
  const trace = new TextEncoder().encode(
    JSON.stringify({ traceEvents: [{ name: "RunTask", ph: "X", ts: 1, dur: 180_000 }] })
  );
  add(150, "perf.trace", {
    traceHash: addBlob("application/json", trace),
    durationMs: 1_200,
    mode: "reportEvents",
    categories: "metrics",
    reason: "session-start",
    size: trace.byteLength
  });
  add(2_000, "perf.vitals", { ttfb: 182 });
  add(2_600, "perf.vitals", { lcp: 2_480 });
  add(9_600, "perf.vitals", { cls: 0.04 });
  add(11_300, "perf.vitals", { cls: 0.12, inp: 264 });
  add(9_500, "perf.longtask", { name: "self", startTime: 9_500, duration: 180 });
  add(10_900, "perf.longtask", { name: "self", startTime: 10_900, duration: 95 });
  add(11_100, "perf.longtask", { name: "self", startTime: 11_100, duration: 240 });
}

/**
 * Session B for Compare: the same recording where `game/64` answers 503 with a changed body and
 * one more endpoint appears. `sha256Hex` is the session builder's hash helper.
 */
export function buildCompareVariant(session, sha256Hex) {
  const body = new TextEncoder().encode(
    JSON.stringify({ id: 64, title: "Live table 64", status: "closed", reason: "maintenance" })
  );
  const hash = sha256Hex(body);
  const changed = session.events.map((event) => {
    if (event.data?.requestId !== "90080.1700" && event.data?.reqId !== "90080.1700") {
      return event;
    }

    if (event.type === "network.response") {
      return {
        ...event,
        data: {
          ...event.data,
          response: { ...event.data.response, status: 503, statusText: "Service Unavailable" }
        }
      };
    }

    return event.type === "network.body"
      ? { ...event, data: { ...event.data, contentHash: hash, size: body.byteLength } }
      : event;
  });
  const last = session.events.at(-1);
  const extra = {
    ...last,
    id: "E-90000001",
    type: "network.request",
    mono: last.mono - 500,
    t: last.t - 500,
    ref: { req: "90090.1" },
    data: {
      requestId: "90090.1",
      type: "XHR",
      initiator: { type: "script" },
      request: { url: "https://app.example.test/gw/bff/maintenance/status", method: "GET" }
    }
  };

  return {
    ...session,
    blobs: [...session.blobs, { hash, mime: "application/json", bytes: body }],
    events: [...changed, extra].sort((a, b) => a.mono - b.mono || a.id.localeCompare(b.id))
  };
}
