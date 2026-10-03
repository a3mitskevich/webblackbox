import { buildPlaywrightActionLines, isPlaywrightReplayableEvent } from "@webblackbox/player-sdk";
import type { WebBlackboxEvent } from "@webblackbox/protocol";

export type PlayerPlaywrightScriptOptions = {
  name?: string;
  maxActions?: number;
  includeHarReplay?: boolean;
  startUrl?: string;
};

export function generatePlaywrightScriptFromEvents(
  events: WebBlackboxEvent[],
  options: PlayerPlaywrightScriptOptions = {}
): string {
  const name = options.name ?? "replay-from-webblackbox";
  const maxActions = Math.max(1, options.maxActions ?? 40);
  const includeHarReplay = options.includeHarReplay ?? true;
  const startUrl = options.startUrl ?? "about:blank";
  const actions = events.filter(isPlaywrightReplayableEvent).slice(0, maxActions);

  const lines = [
    "import { test } from '@playwright/test';",
    "",
    `test('${name}', async ({ browser }) => {`,
    "  const context = await browser.newContext();",
    includeHarReplay
      ? "  await context.routeFromHAR('./session.har', { notFound: 'fallback' });"
      : "  // HAR replay disabled.",
    "  const page = await context.newPage();",
    `  await page.goto(${JSON.stringify(startUrl)});`
  ];

  lines.push(...buildPlaywrightActionLines(actions));

  lines.push("  await context.close();", "});");

  return lines.join("\n");
}
