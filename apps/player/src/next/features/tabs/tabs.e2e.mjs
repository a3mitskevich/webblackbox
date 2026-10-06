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

const seconds = (clock) => {
  const [minutes, rest] = clock.split(" / ")[0].replace(",", ".").split(":");
  return Number(minutes) * 60 + Number(rest);
};

/**
 * The "other tabs open" badge, clicked mid-playback, opens the Tabs panel: the archive stays
 * loaded, playback goes on from where it was (no restart from zero) and the selection is kept.
 */
async function badgeOpensTabsPanel(ctx) {
  await ctx.openSynthetic({ hash: "#t=8.00&sel=req:90080.1706&tab=network" });
  await ctx.waitForSelector(ctx.testId("other-tabs-chip"), "No other-tabs badge");
  const start = await ctx.snapshot();
  await ctx.click("play-toggle");
  await ctx.waitForSnapshot(
    (value) => value.playing === "true" && seconds(value.clock) > seconds(start.clock),
    "Playback did not start"
  );
  const before = await ctx.snapshot();
  await ctx.click("other-tabs-chip");
  const after = await ctx.waitForSnapshot(
    (value) => value.tab === "tab-tabs",
    "The badge did not open the Tabs panel"
  );
  await ctx.waitForSelector(ctx.testId("tabs-panel"), "The Tabs panel did not render");
  ctx.assert(
    seconds(after.clock) >= seconds(before.clock) && after.playing === "true",
    "The badge restarted or stopped playback",
    { before: before.clock, after: after.clock, playing: after.playing }
  );
  ctx.assert(after.unloads === start.unloads, "The badge reloaded the page", { after });

  await ctx.click("play-toggle");
  const paused = await ctx.waitForSnapshot(
    (value) => value.playing === "false" && value.hash.includes("tab=tabs"),
    "The URL did not settle after pausing"
  );
  ctx.assert(
    paused.hash.includes("sel=req%3A90080.1706") && seconds(paused.clock) >= seconds(after.clock),
    "The badge lost the selection or moved the playhead back",
    { hash: paused.hash, clock: paused.clock }
  );
  return { before: before.clock, after: after.clock, hash: paused.hash };
}

export default {
  feature: "tabs",
  scenarios: [
    { name: "open tabs follow the playhead", run: openTabsFollowThePlayhead },
    { name: "the other-tabs badge opens the Tabs panel mid-playback", run: badgeOpensTabsPanel }
  ]
};
