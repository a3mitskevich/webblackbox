import type { WebBlackboxPlayer } from "./index.js";
import { buildPlaywrightActionLines, selectPlaywrightActions } from "./playwright-actions.js";
import type { PlaywrightMockScriptOptions, PlaywrightScriptOptions } from "./types.js";

export function buildCurlCommand(
  player: Pick<WebBlackboxPlayer, "getNetworkWaterfall">,
  reqId: string
): string | null {
  const entry = player.getNetworkWaterfall().find((item) => item.reqId === reqId);

  if (!entry) {
    return null;
  }

  const lines = [
    `curl ${shellQuote(entry.url)} \\`,
    `  -X ${shellQuote(entry.method.toUpperCase())} \\`
  ];

  for (const [name, value] of Object.entries(entry.requestHeaders)) {
    lines.push(`  -H ${shellQuote(`${name}: ${value}`)} \\`);
  }

  if (entry.requestBodyText) {
    lines.push(`  --data-raw ${shellQuote(entry.requestBodyText)} \\`);
  }

  lines.push("  --compressed");

  return lines.join("\n");
}

export function buildFetchSnippet(
  player: Pick<WebBlackboxPlayer, "getNetworkWaterfall">,
  reqId: string
): string | null {
  const entry = player.getNetworkWaterfall().find((item) => item.reqId === reqId);

  if (!entry) {
    return null;
  }

  const options: Record<string, unknown> = {
    method: entry.method.toUpperCase(),
    headers: entry.requestHeaders
  };

  if (entry.requestBodyText) {
    options.body = entry.requestBodyText;
  }

  return `await fetch(${JSON.stringify(entry.url)}, ${JSON.stringify(options, null, 2)});`;
}

export function buildPlaywrightScript(
  player: Pick<WebBlackboxPlayer, "query" | "archive">,
  options: PlaywrightScriptOptions
): string {
  const name = options.name ?? "replay-from-webblackbox";
  const maxActions = Math.max(1, options.maxActions ?? 40);
  const includeHarReplay = options.includeHarReplay ?? true;
  const actions = selectPlaywrightActions(player.query({ range: options.range }), maxActions);

  const lines = [
    "import { test } from '@playwright/test';",
    "",
    `test(${JSON.stringify(name)}, async ({ browser }) => {`,
    "  const context = await browser.newContext();",
    includeHarReplay
      ? "  await context.routeFromHAR('./session.har', { notFound: 'fallback' });"
      : "  // HAR replay disabled.",
    "  const page = await context.newPage();",
    `  await page.goto(${JSON.stringify(options.startUrl ?? player.archive.manifest.site.origin)});`
  ];

  lines.push(...buildPlaywrightActionLines(actions));

  lines.push("  await context.close();", "});");

  return lines.join("\n");
}

export async function buildPlaywrightMockScript(
  player: Pick<WebBlackboxPlayer, "query" | "getNetworkWaterfall" | "getBlob" | "archive">,
  options: PlaywrightMockScriptOptions
): Promise<string> {
  const name = options.name ?? "replay-with-mocks";
  const maxActions = Math.max(1, options.maxActions ?? 40);
  const maxMocks = Math.max(1, options.maxMocks ?? 25);
  const actions = selectPlaywrightActions(player.query({ range: options.range }), maxActions);

  const mockEntries = player
    .getNetworkWaterfall(options.range)
    .filter((entry) => Boolean(entry.responseBodyHash) && typeof entry.status === "number")
    .slice(0, maxMocks);

  const lines = [
    "import { test } from '@playwright/test';",
    "",
    `test(${JSON.stringify(name)}, async ({ browser }) => {`,
    "  const context = await browser.newContext();"
  ];

  for (const entry of mockEntries) {
    const body = await readMockResponseBody(player, entry.responseBodyHash);

    if (!body) {
      continue;
    }

    lines.push(
      `  await context.route(${JSON.stringify(entry.url)}, async route => route.fulfill(${JSON.stringify(
        {
          status: entry.status,
          headers: sanitizeMockHeaders(entry.responseHeaders),
          body
        },
        null,
        2
      )}));`
    );
  }

  lines.push(
    "  const page = await context.newPage();",
    `  await page.goto(${JSON.stringify(options.startUrl ?? player.archive.manifest.site.origin)});`
  );

  lines.push(...buildPlaywrightActionLines(actions));

  lines.push("  await context.close();", "});");

  return lines.join("\n");
}

async function readMockResponseBody(
  player: Pick<WebBlackboxPlayer, "getBlob">,
  hash?: string
): Promise<string | null> {
  if (!hash) {
    return null;
  }

  const blob = await player.getBlob(hash);

  if (!blob) {
    return null;
  }

  const text = new TextDecoder().decode(blob.bytes);

  if (text.trim().length === 0) {
    return null;
  }

  return text;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function sanitizeMockHeaders(headers: Record<string, string>): Record<string, string> {
  const excluded = new Set([
    "set-cookie",
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "connection"
  ]);

  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !excluded.has(name.toLowerCase()))
  );
}
