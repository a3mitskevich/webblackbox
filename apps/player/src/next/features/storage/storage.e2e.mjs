// e2e:player-next scenarios of the storage feature (R4), picked up by scripts/e2e-player-next.mjs.

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

const keysExpression = (ctx) =>
  `[...document.querySelectorAll('${ctx.testId("storage-item")} .key')].map((cell) => cell.textContent).join(",")`;

/** Storage at the playhead: seeking through the URL hash rebuilds localStorage at that moment. */
async function stateFollowsThePlayhead(ctx) {
  await ctx.openSynthetic({ hash: "#t=1&tab=storage" });
  await ctx.waitForSelector(ctx.testId("storage-state"), "The Storage tab did not open");
  const early = await waitForValue(
    ctx,
    `(() => { const keys = ${keysExpression(ctx)}; return keys === "clientId,lang" && keys; })()`,
    "localStorage at 0:01 is not the start snapshot"
  );

  await ctx.evaluate(`location.hash = "#t=15&tab=storage"`);
  const late = await waitForValue(
    ctx,
    `(() => { const keys = ${keysExpression(ctx)}; return keys === "lang,lobbyState" && keys; })()`,
    "localStorage did not follow the playhead to 0:15"
  );

  await ctx.click("storage-area-cookie");
  const cookie = await waitForValue(
    ctx,
    `document.querySelector('${ctx.testId("storage-cookie")}')?.textContent.includes("HttpOnly") && document.querySelector('${ctx.testId("storage-cookie")}').textContent`,
    "Cookies with values and flags are not shown"
  );
  await ctx.click("storage-area-local");
  return { early, late, cookie };
}

/** The log opens a write with its field-level old → new diff. */
async function logShowsTheChange(ctx) {
  await ctx.openSynthetic({ hash: "#tab=storage" });
  await ctx.waitForSelector(ctx.testId("storage-state"), "The Storage tab did not open");
  await ctx.click("storage-view-log");
  await ctx.waitForSelector(ctx.testId("storage-log"), "The storage log did not open");
  await ctx.evaluate(
    `[...document.querySelectorAll('${ctx.testId("storage-change")}')].filter((row) => row.textContent.includes("lobbyState"))[1].click()`
  );
  const fields = await waitForValue(
    ctx,
    `document.querySelector('${ctx.testId("storage-field-changes")}')?.textContent`,
    "The write did not show its field changes"
  );
  ctx.assert(fields.includes("1 → 2"), "The field diff misses the version change", { fields });
  await ctx.click("storage-view-state");
  return { fields };
}

export default {
  feature: "storage",
  scenarios: [
    { name: "storage state follows the playhead", run: stateFollowsThePlayhead },
    { name: "the log shows a write's old → new diff", run: logShowsTheChange }
  ]
};
