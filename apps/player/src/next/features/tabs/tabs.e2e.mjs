// e2e:player scenarios of the tabs feature (R4), picked up by scripts/e2e-player.mjs.

const POLL_MS = 100;
const TIMEOUT_MS = 8_000;

async function waitForValue(ctx, expression, message) {
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    const value = await ctx.evaluate(expression);

    if (value) {
      return value;
    }

    await ctx.sleep(POLL_MS);
  }

  throw new Error(message);
}

/** The other tabs open at the playhead follow it; a change row seeks to it. */
async function openTabsFollowThePlayhead(ctx) {
  await ctx.openSynthetic({ hash: "#tab=tabs" });
  await ctx.waitForSelector(ctx.testId("tabs-panel"), "The Tabs tab did not open");
  const openCount = () =>
    ctx.evaluate(`document.querySelectorAll('${ctx.testId("tabs-open-tab")}').length`);
  const atStart = await openCount();
  ctx.assert(atStart === 2, "Two other tabs should be open at the start", { atStart });

  await ctx.evaluate(
    `[...document.querySelectorAll('${ctx.testId("tabs-change")}')].find((row) => row.dataset.kind === "closed").click()`
  );
  await waitForValue(
    ctx,
    `document.querySelectorAll('${ctx.testId("tabs-open-tab")}').length === 1`,
    "Seeking to the closed change did not update the open tabs"
  );
  const clock = await ctx.evaluate(`document.querySelector('${ctx.testId("clock")}').textContent`);
  return { atStart, clock };
}

export default {
  feature: "tabs",
  scenarios: [{ name: "open tabs follow the playhead", run: openTabsFollowThePlayhead }]
};
