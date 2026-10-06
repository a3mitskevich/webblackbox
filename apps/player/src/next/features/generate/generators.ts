import {
  buildRouteChapters,
  type GitHubIssueTemplate,
  type JiraIssueTemplate
} from "@webblackbox/player-sdk";

import type { TimeRange } from "../../../core/time-range.js";
import { generatePlaywrightScriptFromEvents } from "../../../lib/playwright-script.js";
import type { LoadedArchive } from "../../state.js";
import type { GenerateKind } from "./api.js";
import { toPlayerRange } from "./range.js";

/**
 * What each generator produces, from player-sdk only. Pure functions of the archive and the
 * options, so the dialogs stay thin and the outputs are unit-tested here.
 */

/** Download names (the classic player's, so existing scripts and habits keep working). */
export const GENERATE_FILE_NAMES: Record<GenerateKind, string> = {
  playwright: "webblackbox-replay.spec.ts",
  "playwright-mocks": "webblackbox-replay-mocks.spec.ts",
  "bug-report": "webblackbox-report.md",
  har: "webblackbox-session.har",
  "github-issue": "webblackbox-github-issue.json",
  "jira-issue": "webblackbox-jira-issue.json"
};

/** The classic "Playwright with mocks" export mocked at most this many responses. */
export const MAX_MOCKS = 25;

export type PlaywrightOptions = {
  range: TimeRange | null;
  maxActions: number;
  includeHarReplay: boolean;
};

/**
 * Where the test opens: the page the user was on when the range starts (a test "from 9.45 s"
 * must not start on the landing page), or the site origin for the whole session.
 */
export function resolveStartUrl(archive: LoadedArchive, range: TimeRange | null): string {
  const origin = archive.player.archive.manifest.site.origin;

  if (!range) {
    return origin;
  }

  const chapters = buildRouteChapters(archive.model.events, {
    endMono: archive.model.maxMono,
    initialUrl: origin
  });
  const current = chapters.filter((chapter) => chapter.startMono <= range.startMono).at(-1);
  return current?.url ?? origin;
}

/** The recorded actions in the range as a Playwright test (classic preview dialog). */
export function buildPlaywrightScript(archive: LoadedArchive, options: PlaywrightOptions): string {
  const { range } = options;
  const events = range
    ? archive.model.events.filter(
        (event) => event.mono >= range.startMono && event.mono <= range.endMono
      )
    : archive.model.events;

  return generatePlaywrightScriptFromEvents(events, {
    maxActions: options.maxActions,
    includeHarReplay: options.includeHarReplay,
    startUrl: resolveStartUrl(archive, range)
  });
}

/** The same test with the recorded responses served by `page.route` mocks. */
export function buildPlaywrightMockScript(
  archive: LoadedArchive,
  options: Omit<PlaywrightOptions, "includeHarReplay">
): Promise<string> {
  return archive.player.generatePlaywrightMockScript({
    range: toPlayerRange(options.range),
    maxActions: options.maxActions,
    maxMocks: MAX_MOCKS,
    startUrl: resolveStartUrl(archive, options.range)
  });
}

export function buildBugReport(archive: LoadedArchive, range: TimeRange | null): string {
  return archive.player.generateBugReport({ range: toPlayerRange(range) });
}

export type HarExport = {
  text: string;
  entries: number;
};

export function buildHar(archive: LoadedArchive, range: TimeRange | null): HarExport {
  const playerRange = toPlayerRange(range);
  return {
    text: archive.player.exportHar(playerRange),
    entries: archive.player.getNetworkWaterfall(playerRange).length
  };
}

export function buildGitHubIssue(
  archive: LoadedArchive,
  range: TimeRange | null
): GitHubIssueTemplate {
  return archive.player.generateGitHubIssueTemplate({ range: toPlayerRange(range) });
}

export function buildJiraIssue(archive: LoadedArchive, range: TimeRange | null): JiraIssueTemplate {
  return archive.player.generateJiraIssueTemplate({ range: toPlayerRange(range) });
}
