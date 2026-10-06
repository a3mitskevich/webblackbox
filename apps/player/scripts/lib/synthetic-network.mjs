// Network events of the synthetic session that the R3 Network tab shows: bodies the capture did
// not keep (PR #21 `network.body.skipped`, `postDataSkipped`), a body cut at the profile limit, a
// form POST and an SSE stream. Everything answers 2xx, so the problems strip is not affected.
// Called once from buildSyntheticSession (synthetic-session.mjs) with its event helpers.

const MB = 1_048_576;

/**
 * @param {{
 *   add: (offsetMs: number, type: string, data: unknown, extra?: object) => string,
 *   addBlob: (mime: string, bytes: Uint8Array) => string,
 *   request: (offsetMs: number, durationMs: number, options: object) => void,
 *   origin: string
 * }} helpers
 */
export function addSyntheticNetworkEvents({ add, addBlob, request, origin }) {
  const ref = (reqId) => ({ ref: { req: reqId } });

  // A CSV export larger than the profile limit: the body was skipped with sizes.
  request(4_000, 180, {
    reqId: "90080.1400",
    url: `${origin}/gw/bff/reports/api/v1.0/export.csv`,
    mimeType: "text/csv"
  });
  add(
    4_180,
    "network.body.skipped",
    {
      reqId: "90080.1400",
      side: "response",
      reason: "too-large",
      mimeType: "text/csv",
      size: 5 * MB,
      limit: MB
    },
    ref("90080.1400")
  );

  // A body kept only up to the profile limit (a JSON prefix).
  const games = JSON.stringify({ games: [{ id: 64, title: "Live table 64" }, { id: 65 }] });
  const prefix = new TextEncoder().encode(games.slice(0, 40));
  request(4_200, 90, {
    reqId: "90080.1410",
    url: `${origin}/gw/bff/lobby/api/v1.0/games`
  });
  add(
    4_290,
    "network.body",
    {
      reqId: "90080.1410",
      contentHash: addBlob("application/json", prefix),
      mimeType: "application/json",
      size: prefix.byteLength,
      sampledSize: prefix.byteLength,
      redacted: false,
      truncated: true
    },
    ref("90080.1410")
  );

  // A POST whose body the browser does not expose (streamed request body).
  postRequest(add, 4_400, 60, {
    reqId: "90080.1420",
    url: `${origin}/gw/bff/telemetry/api/v1.0/events`,
    request: { hasPostData: true, postDataSkipped: "unavailable" },
    status: 204,
    mimeType: "text/plain"
  });

  // A form POST: the payload tab shows the fields; the answer is JSON.
  postRequest(add, 4_600, 80, {
    reqId: "90080.1430",
    url: `${origin}/gw/bff/users/api/v1.0/preferences?lang=en`,
    request: {
      postData: "theme=dark&lang=en&note=two+words",
      headers: { "content-type": "application/x-www-form-urlencoded" }
    },
    status: 200,
    mimeType: "application/json",
    responseBlob: addBlob("application/json", new TextEncoder().encode('{"saved":true}'))
  });

  // Server-sent events on one request.
  // Before 6.5 s: the 6.5 s → 9.42 s stretch stays idle (skip-idle tests use it).
  request(4_700, 1_500, {
    reqId: "90080.1440",
    url: `${origin}/gw/bff/feed/api/v1.0/stream`,
    mimeType: "text/event-stream"
  });

  for (const [index, offsetMs] of [4_800, 5_300, 5_900].entries()) {
    add(
      offsetMs,
      "network.sse.message",
      {
        requestId: "90080.1440",
        phase: "message",
        eventType: "tick",
        lastEventId: String(index + 1),
        data: JSON.stringify({ table: 64, price: 1.5 + index / 10 })
      },
      ref("90080.1440")
    );
  }
}

function postRequest(add, offsetMs, durationMs, options) {
  const ref = { ref: { req: options.reqId } };
  const { headers = {}, ...request } = options.request;

  add(
    offsetMs,
    "network.request",
    {
      requestId: options.reqId,
      type: "Fetch",
      initiator: { type: "script" },
      request: { url: options.url, method: "POST", headers, ...request }
    },
    ref
  );
  add(
    offsetMs + durationMs * 0.9,
    "network.response",
    {
      requestId: options.reqId,
      type: "Fetch",
      response: {
        url: options.url,
        status: options.status,
        statusText: options.status === 204 ? "No Content" : "OK",
        headers: { "content-type": options.mimeType },
        mimeType: options.mimeType,
        protocol: "h2"
      }
    },
    ref
  );
  add(offsetMs + durationMs, "network.finished", { requestId: options.reqId }, ref);

  if (options.responseBlob) {
    add(
      offsetMs + durationMs,
      "network.body",
      {
        reqId: options.reqId,
        contentHash: options.responseBlob,
        mimeType: options.mimeType,
        size: 14,
        sampledSize: 14,
        redacted: false,
        truncated: false
      },
      ref
    );
  }
}
