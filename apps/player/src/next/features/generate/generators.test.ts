import { buildRouteChapters } from "@webblackbox/player-sdk";
import { beforeAll, describe, expect, it } from "vitest";

import type { LoadedArchive } from "../../state.js";
import { loadSyntheticArchive } from "../test-archive.js";
import {
  buildBugReport,
  buildGitHubIssue,
  buildHar,
  buildJiraIssue,
  buildPlaywrightMockScript,
  buildPlaywrightScript,
  resolveStartUrl
} from "./generators.js";

let archive: LoadedArchive;
let origin: string;

beforeAll(async () => {
  archive = await loadSyntheticArchive();
  origin = archive.player.archive.manifest.site.origin;
});

/** The second half of the recording. */
function laterHalf() {
  const { minMono, maxMono } = archive.model;
  return { startMono: minMono + (maxMono - minMono) / 2, endMono: maxMono };
}

describe("generators", () => {
  it("writes the whole session as a Playwright test with HAR replay", () => {
    const script = buildPlaywrightScript(archive, {
      range: null,
      maxActions: 40,
      includeHarReplay: true
    });

    expect(script).toContain("import { test } from '@playwright/test';");
    expect(script).toContain(`await page.goto(${JSON.stringify(origin)});`);
    expect(script).toContain("routeFromHAR('./session.har'");
    expect(script).toContain(".click(");
  });

  it("honours the action cap, the HAR switch and the range", () => {
    const options = { range: null, maxActions: 40, includeHarReplay: false };
    const whole = buildPlaywrightScript(archive, options);
    const capped = buildPlaywrightScript(archive, { ...options, maxActions: 1 });
    const later = buildPlaywrightScript(archive, { ...options, range: laterHalf() });

    expect(whole).toContain("// HAR replay disabled.");
    expect(capped.split("\n").length).toBeLessThan(whole.split("\n").length);
    expect(later.split("\n").length).toBeLessThan(whole.split("\n").length);
  });

  it("starts a ranged test on the page the user was on at the range start", () => {
    const chapters = buildRouteChapters(archive.model.events, {
      endMono: archive.model.maxMono,
      initialUrl: origin
    });
    const later = chapters.filter((chapter) => chapter.url && chapter.url !== origin).at(-1);

    expect(later).toBeDefined();
    expect(resolveStartUrl(archive, null)).toBe(origin);
    expect(
      resolveStartUrl(archive, {
        startMono: (later?.startMono ?? 0) + 1,
        endMono: archive.model.maxMono
      })
    ).toBe(later?.url);
  });

  it("mocks recorded responses in the mock script", async () => {
    const script = await buildPlaywrightMockScript(archive, { range: null, maxActions: 40 });

    expect(script).toContain('test("replay-with-mocks"');
    expect(script).toContain("context.route(");
  });

  it("keeps the bug report, HAR and issue templates to the range", () => {
    const report = buildBugReport(archive, null);
    expect(report).toContain("## Not Captured");
    expect(report).toContain(origin);

    const whole = buildHar(archive, null);
    const later = buildHar(archive, laterHalf());
    expect(JSON.parse(whole.text).log.entries).toHaveLength(whole.entries);
    expect(whole.entries).toBe(archive.player.getNetworkWaterfall().length);
    expect(later.entries).toBeLessThan(whole.entries);

    const github = buildGitHubIssue(archive, null);
    expect(github.labels).toEqual(["bug", "webblackbox"]);
    expect(github.body).toContain("## Not Captured");

    const jira = buildJiraIssue(archive, null);
    expect(jira.fields.issuetype.name).toBe("Bug");
    expect(jira.fields.description).toContain(origin);
  });
});
