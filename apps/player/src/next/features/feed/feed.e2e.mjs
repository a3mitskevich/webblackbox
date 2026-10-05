// e2e:player-next scenarios of the feed feature (picked up by scripts/e2e-player-next.mjs).
// Each scenario gets a context with the CDP client and data-testid helpers (createScenarioContext
// in scripts/lib/next-e2e.mjs); R2 replaces these with the action → consequences feed checks.

/** Rows and the tab count follow the Activity filter. */
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

  // Typing in the filter must not trigger the keymap (`e` would jump to an error).
  ctx.assert(!filtered.live.startsWith("Error"), "Typing in the filter fired a shortcut", filtered);
  return { rowsBefore: before.rows, rowsAfter: filtered.rows, countBefore, countAfter };
}

/**
 * Enter opens the details pane under the list with its own splitter; Esc closes it. The list stays
 * mounted (focus, scroll) while the pane opens and closes, and the pane comes back at its size.
 */
async function detailsPaneSplits(ctx) {
  const list = ctx.testId("event-list");
  await ctx.openSynthetic();
  await ctx.evaluate(`document.querySelector('${list}').focus()`);
  await ctx.press("l");
  await ctx.waitForSnapshot((value) => value.selectedRow !== null, "L selected nothing");
  // Marks this list node: a remount would drop the mark and the focus.
  await ctx.evaluate(`document.querySelector('${list}').dataset.mark = "kept"`);
  await ctx.press("Enter", { code: "Enter", keyCode: 13 });
  await ctx.waitForSelector(ctx.testId("split-details"), "The details pane has no splitter");

  const listKept = () =>
    ctx.evaluate(`(() => {
      const element = document.querySelector('${list}');
      return element?.dataset.mark === "kept" && document.activeElement === element;
    })()`);
  ctx.assert(await listKept(), "Opening the details remounted the list or lost its focus");

  const height = () =>
    ctx.evaluate(
      `document.querySelector('${ctx.testId("details-panel")}').getBoundingClientRect().height`
    );
  const initial = await height();
  await ctx.dragBy(ctx.testId("split-details"), 0, -80);
  const dragged = await height();
  ctx.assert(dragged > initial + 40, "Dragging the details splitter did not grow the pane", {
    initial,
    dragged
  });

  await ctx.evaluate(`document.querySelector('${list}').focus()`);
  await ctx.press("Escape", { code: "Escape", keyCode: 27 });
  await ctx.waitForSnapshot((value) => value.details === "", "Esc did not close the details");
  ctx.assert(await listKept(), "Closing the details remounted the list or lost its focus");

  await ctx.press("Enter", { code: "Enter", keyCode: 13 });
  await ctx.waitForSelector(ctx.testId("details-panel"), "Enter did not reopen the details");
  const reopened = await height();
  ctx.assert(Math.abs(reopened - dragged) <= 4, "The details pane did not keep its size", {
    dragged,
    reopened
  });
  await ctx.press("Escape", { code: "Escape", keyCode: 27 });
  return { initial, dragged, reopened };
}

export default {
  feature: "feed",
  scenarios: [
    { name: "filter narrows the list and the count", run: filterNarrowsTheList },
    { name: "details pane with a splitter", run: detailsPaneSplits }
  ]
};
