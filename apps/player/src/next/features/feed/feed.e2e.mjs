// e2e:player scenarios of the feed feature (picked up by scripts/e2e-player.mjs): the
// Activity feed (action → consequences, filters, repeats, follow) and the problems strip. Each
// scenario gets a context with the CDP client and data-testid helpers (createScenarioContext in
// scripts/lib/next-e2e.mjs).

/** Reads the feed rows and the strip through their data-testid hooks. */
function readFeed(ctx) {
  return ctx.evaluate(`(() => {
    const all = (id) => [...document.querySelectorAll('[data-testid="' + id + '"]')];
    const q = (id) => document.querySelector('[data-testid="' + id + '"]');
    return {
      rows: all("event-row").map((row) => ({
        id: row.dataset.eventId,
        thirdParty: row.dataset.thirdParty === "true",
        future: row.dataset.future === "true",
        className: row.className,
        expanded: row.dataset.expanded ?? null,
        text: row.textContent
      })),
      chips: all("problem-chip").map((chip) => ({
        key: chip.dataset.problemKey,
        text: chip.textContent,
        pressed: chip.getAttribute("aria-pressed"),
        thirdParty: chip.dataset.thirdParty === "true"
      })),
      problemsCount: q("problems-count")?.textContent ?? "",
      errorsOnly: q("feed-errors-only")?.getAttribute("aria-pressed") ?? "",
      hideThirdParty: q("feed-hide-third-party")?.getAttribute("aria-pressed") ?? "",
      hidden: q("feed-hidden-count")?.textContent ?? "",
      toast: q("toast")?.textContent ?? "",
      flags: all("problem-flag").map((flag) => flag.textContent),
      listScroll: q("event-list")?.scrollTop ?? 0,
      live: q("live-region")?.textContent ?? "",
      clock: q("clock")?.textContent ?? ""
    };
  })()`);
}

async function waitForFeed(ctx, predicate, message, timeoutMs = 8_000) {
  const started = Date.now();
  let last = null;

  while (Date.now() - started < timeoutMs) {
    last = await readFeed(ctx);

    if (predicate(last)) {
      return last;
    }

    await ctx.sleep(100);
  }

  ctx.assert(false, message, last);
  return last;
}

/** Rows and the tab count follow the Activity filter; typing does not fire shortcuts. */
async function filterNarrowsTheList(ctx) {
  await ctx.openSynthetic();
  const before = await ctx.snapshot();
  const countText = () =>
    ctx.evaluate(`document.querySelector('${ctx.testId("tab-activity")}').textContent`);
  const countBefore = await countText();

  await ctx.evaluate(`document.querySelector('${ctx.testId("activity-filter")}').focus()`);
  await ctx.client.send("Input.insertText", { text: "casino-user" });
  const filtered = await ctx.waitForSnapshot(
    (value) => value.rows > 0 && value.rows < before.rows,
    "The Activity filter did not narrow the list"
  );
  const countAfter = await countText();
  ctx.assert(countAfter !== countBefore, "The Activity tab count did not follow the filter", {
    countBefore,
    countAfter
  });
  const feed = await readFeed(ctx);
  ctx.assert(
    feed.rows.every((row) => /casino/i.test(row.text)),
    "A filtered row does not mention the filter",
    feed.rows
  );

  // Typing in the filter must not trigger the keymap (`e` would jump to an error).
  ctx.assert(!filtered.live.startsWith("Error"), "Typing in the filter fired a shortcut", filtered);
  return { rowsBefore: before.rows, rowsAfter: filtered.rows, countBefore, countAfter };
}

/** The strip groups the failures; a chip jumps to the failing moment and walks its occurrences. */
async function problemsStripJumps(ctx) {
  await ctx.openSynthetic();
  const initial = await waitForFeed(
    ctx,
    (value) => value.chips.length > 0,
    "The problems strip shows no problems"
  );
  const [first] = initial.chips;
  ctx.assert(
    /^\d+ problems$/.test(initial.problemsCount) &&
      /^401 Unauthorized×\d+\/gw\/bff\/\*$/.test(first.text),
    "The strip does not lead with the grouped 401s",
    initial
  );
  ctx.assert(
    initial.chips.at(-1).thirdParty && initial.chips.at(-1).text.endsWith("third-party"),
    "Third-party problems are not last and marked",
    initial.chips
  );

  const chip = `[data-testid="problem-chip"][data-problem-key="${first.key}"]`;
  await ctx.evaluate(`document.querySelector('${chip}').click()`);
  const jumped = await waitForFeed(
    ctx,
    (value) => value.live.startsWith("401 Unauthorized: 1 of"),
    "The 401 chip did not jump to its first occurrence"
  );
  const selected = await ctx.waitForSnapshot(
    (value) => value.selectedRow !== null,
    "The jump did not select a feed row"
  );
  ctx.assert(selected.selectedFuture === "false", "The selected problem is dimmed", selected);
  ctx.assert(
    jumped.chips.find((entry) => entry.key === first.key)?.pressed === "true",
    "The chip of the selection is not pressed",
    jumped.chips
  );

  await ctx.evaluate(`document.querySelector('${chip}').click()`);
  const second = await waitForFeed(
    ctx,
    (value) => value.live.startsWith("401 Unauthorized: 2 of"),
    "Clicking the chip again did not step to the next occurrence"
  );
  ctx.assert(second.clock !== jumped.clock, "The next occurrence did not move the playhead", {
    first: jumped.clock,
    second: second.clock
  });
  const flagged = await waitForFeed(
    ctx,
    (value) => value.flags.includes("First auth failure after this click"),
    "The lobby click's first failure is not flagged"
  );
  return {
    problems: initial.problemsCount,
    first: first.text,
    steps: [jumped.clock, second.clock],
    flags: flagged.flags
  };
}

/** Hide third-party is on by default with an "N hidden" chip; Errors only narrows to problems. */
async function feedFilters(ctx) {
  await ctx.openSynthetic();
  const initial = await waitForFeed(
    ctx,
    (value) => value.rows.length > 0 && value.hidden !== "",
    "No hidden third-party chip"
  );
  ctx.assert(
    initial.hideThirdParty === "true" && initial.rows.every((row) => !row.thirdParty),
    "Third-party rows are shown by default",
    initial
  );

  await ctx.click("feed-hidden-count");
  const shown = await waitForFeed(
    ctx,
    (value) =>
      value.hideThirdParty === "false" && value.toast.includes("Third-party activity shown"),
    "The hidden chip did not show third-party rows with a notice"
  );
  ctx.assert(
    shown.rows.some((row) => row.thirdParty),
    "No third-party row after showing them",
    shown
  );
  await ctx.click("toast-action");
  await waitForFeed(
    ctx,
    (value) => value.hideThirdParty === "true" && value.rows.every((row) => !row.thirdParty),
    "The toast action did not hide third-party rows again"
  );

  await ctx.click("feed-errors-only");
  const errors = await waitForFeed(
    ctx,
    (value) => value.errorsOnly === "true" && value.rows.length > 0,
    "Errors only did not apply"
  );
  ctx.assert(errors.rows.length < initial.rows.length, "Errors only did not narrow the feed", {
    before: initial.rows.length,
    after: errors.rows.length
  });
  ctx.assert(
    errors.rows.every((row) => /tone-error|is-action/.test(row.className)),
    "Errors only kept a row that is neither a problem nor its action",
    errors.rows
  );
  await ctx.click("feed-errors-only");
  return { hidden: initial.hidden, rows: initial.rows.length, errorRows: errors.rows.length };
}

/** "×N" rows open (click, then ← closes); the feed follows the playhead. */
async function repeatsAndFollow(ctx) {
  await ctx.openSynthetic();
  const initial = await waitForFeed(
    ctx,
    (value) => value.rows.some((row) => row.expanded === "false"),
    "The feed has no repeat group"
  );
  const group = initial.rows.find((row) => row.expanded === "false");
  const groupRow = `[data-testid="event-row"][data-event-id="${group.id}"]`;
  await ctx.evaluate(`document.querySelector('${groupRow} [data-testid="repeat-toggle"]').click()`);
  const opened = await waitForFeed(
    ctx,
    (value) => value.rows.find((row) => row.id === group.id)?.expanded === "true",
    "The repeat group did not open"
  );
  // Only the rows in view are rendered, so check the row under the head, not the row count.
  const headIndex = opened.rows.findIndex((row) => row.id === group.id);
  ctx.assert(
    opened.rows[headIndex + 1]?.className.includes("nested"),
    "Opening the group listed no repeat under its head",
    opened.rows.slice(headIndex, headIndex + 3)
  );

  // Select the group's head, then ← closes it (tree-like keys on the listbox).
  await ctx.evaluate(`document.querySelector('${groupRow}').click()`);
  await ctx.evaluate(`document.querySelector('${ctx.testId("event-list")}').focus()`);
  await ctx.press("ArrowLeft", { code: "ArrowLeft", keyCode: 37 });
  await waitForFeed(
    ctx,
    (value) => value.rows.find((row) => row.id === group.id)?.expanded === "false",
    "ArrowLeft did not close the group"
  );

  // Follow: with nothing selected, moving the playhead to the end scrolls the feed with it.
  await ctx.openSynthetic();
  await ctx.press("End", { code: "End", keyCode: 35 });
  const followed = await waitForFeed(
    ctx,
    (value) => value.listScroll > 0 && value.rows.length > 0 && !value.rows.at(-1).future,
    "The feed did not follow the playhead to the end"
  );
  return {
    group: group.id,
    nested: opened.rows[headIndex + 1]?.id,
    scroll: followed.listScroll
  };
}

/** Hovering the timeline shows the moment: time, screenshot and nearby items to jump to. */
async function timelineHoverCard(ctx) {
  await ctx.openSynthetic();
  await ctx.hover(ctx.testId("scrubber"));
  await ctx.waitForSelector(ctx.testId("scrub-hover"), "No hover card over the timeline");
  const card = await ctx.evaluate(`(() => {
    const card = document.querySelector('${ctx.testId("scrub-hover")}');
    return {
      text: card.textContent,
      thumbnail: Boolean(card.querySelector("img")?.getAttribute("src")),
      tags: card.querySelectorAll('${ctx.testId("scrub-hover-tag")}').length
    };
  })()`);
  ctx.assert(/\d[.,]\d\d\s?(s|с|秒)/.test(card.text), "The hover card shows no time", card);

  if (card.tags > 0) {
    await ctx.click("scrub-hover-tag");
    await ctx.waitForSnapshot(
      (value) => value.selectedRow !== null,
      "A hover tag selected nothing"
    );
  }

  return card;
}

/** Switching the language keeps the feed's filters and translates the strip and the chip. */
async function languageKeepsFilters(ctx) {
  await ctx.openSynthetic();
  await waitForFeed(ctx, (value) => value.hidden !== "", "No hidden chip");
  await ctx.click("feed-errors-only");
  const english = await waitForFeed(ctx, (value) => value.errorsOnly === "true", "Errors only");

  await ctx.click("locale-ru");
  const russian = await waitForFeed(
    ctx,
    (value) => /^скрыто \d+$/.test(value.hidden) && /проблем/.test(value.problemsCount),
    "The feed was not translated in place"
  );
  ctx.assert(
    russian.errorsOnly === "true" && russian.rows.length === english.rows.length,
    "The language switch reset the feed filters",
    { english: english.rows.length, russian: russian.rows.length }
  );
  await ctx.click("locale-en");
  await ctx.click("feed-errors-only");
  return { hidden: russian.hidden, problems: russian.problemsCount };
}

export default {
  feature: "feed",
  scenarios: [
    { name: "filter narrows the list and the count", run: filterNarrowsTheList },
    { name: "problems strip jumps to the failing moment", run: problemsStripJumps },
    { name: "hide third-party and errors only", run: feedFilters },
    { name: "repeat groups and follow playhead", run: repeatsAndFollow },
    { name: "timeline hover card", run: timelineHoverCard },
    { name: "language switch keeps the feed filters", run: languageKeepsFilters }
  ]
};
