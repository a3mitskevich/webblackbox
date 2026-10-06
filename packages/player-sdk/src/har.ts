import type { WebBlackboxPlayer } from "./index.js";
import type { NetworkWaterfallEntry, PlayerRange } from "./types.js";

export function buildHarExport(
  player: Pick<WebBlackboxPlayer, "getNetworkWaterfall" | "events" | "archive">,
  range?: PlayerRange
): string {
  const entries = player.getNetworkWaterfall(range).map((entry) => toHarEntry(entry));
  const started = new Date(player.events[0]?.t ?? Date.now()).toISOString();

  const har = {
    log: {
      version: "1.2",
      creator: {
        name: "WebBlackbox",
        version: "1.0.0"
      },
      pages: [
        {
          startedDateTime: started,
          id: "page_1",
          title: player.archive.manifest.site.title ?? player.archive.manifest.site.origin,
          pageTimings: {
            onContentLoad: -1,
            onLoad: -1
          }
        }
      ],
      entries
    }
  };

  return JSON.stringify(har, null, 2);
}

function toHarEntry(entry: NetworkWaterfallEntry): Record<string, unknown> {
  const queryString = parseQueryString(entry.url);
  const requestCookies = parseCookieHeader(entry.requestHeaders.cookie);
  const responseCookies = parseSetCookieHeader(entry.responseHeaders["set-cookie"]);

  const postData = entry.requestBodyText
    ? {
        mimeType: entry.requestHeaders["content-type"] ?? "application/octet-stream",
        text: entry.requestBodyText
      }
    : undefined;

  return {
    pageref: "page_1",
    startedDateTime: new Date(entry.startWallTime).toISOString(),
    time: entry.durationMs,
    request: {
      method: entry.method.toUpperCase(),
      url: entry.url,
      httpVersion: "HTTP/1.1",
      cookies: requestCookies,
      headers: headersToHarArray(entry.requestHeaders),
      queryString,
      postData,
      headersSize: -1,
      bodySize: entry.requestBodyText?.length ?? -1
    },
    response: {
      status: entry.status ?? 0,
      statusText: entry.statusText ?? "",
      httpVersion: "HTTP/1.1",
      cookies: responseCookies,
      headers: headersToHarArray(entry.responseHeaders),
      content: {
        size: entry.responseBodySize ?? entry.encodedDataLength ?? 0,
        mimeType: entry.mimeType ?? "application/octet-stream"
      },
      redirectURL: entry.responseHeaders.location ?? "",
      headersSize: -1,
      bodySize: entry.responseBodySize ?? -1
    },
    cache: {},
    timings: {
      blocked: -1,
      dns: -1,
      connect: -1,
      ssl: -1,
      send: 0,
      wait: entry.durationMs,
      receive: 0
    }
  };
}

function headersToHarArray(
  headers: Record<string, string>
): Array<{ name: string; value: string }> {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function parseQueryString(urlValue: string): Array<{ name: string; value: string }> {
  try {
    const url = new URL(urlValue);
    return [...url.searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function parseCookieHeader(
  headerValue: string | undefined
): Array<{ name: string; value: string }> {
  if (!headerValue) {
    return [];
  }

  return headerValue
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, ...rest] = part.split("=");
      return {
        name: name?.trim() ?? "",
        value: rest.join("=").trim()
      };
    })
    .filter((cookie) => cookie.name.length > 0);
}

function parseSetCookieHeader(
  headerValue: string | undefined
): Array<{ name: string; value: string }> {
  if (!headerValue) {
    return [];
  }

  const first = headerValue.split(";")[0];

  if (!first) {
    return [];
  }

  const [name, ...rest] = first.split("=");

  if (!name) {
    return [];
  }

  return [
    {
      name: name.trim(),
      value: rest.join("=").trim()
    }
  ];
}
