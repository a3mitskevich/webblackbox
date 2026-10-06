import { buildPlaywrightActionLines, selectPlaywrightActions } from "@webblackbox/player-sdk";
import type { WebBlackboxEvent } from "@webblackbox/protocol";

/**
 * The HAR the generated test replays: the name the Player downloads it under (Generate → HAR file),
 * so saving both next to each other is all the setup the test needs.
 */
export const HAR_FILE_NAME = "webblackbox-session.har";

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
  const actions = selectPlaywrightActions(events, maxActions);

  const lines = [
    "import { test } from '@playwright/test';",
    "",
    `test(${JSON.stringify(name)}, async ({ browser }) => {`,
    "  const context = await browser.newContext();",
    includeHarReplay
      ? `  await context.routeFromHAR('./${HAR_FILE_NAME}', { notFound: 'fallback' });`
      : "  // HAR replay disabled.",
    "  const page = await context.newPage();",
    `  await page.goto(${JSON.stringify(startUrl)});`
  ];

  lines.push(...buildPlaywrightActionLines(actions));

  lines.push("  await context.close();", "});");

  return lines.join("\n");
}
