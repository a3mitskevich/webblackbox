// e2e:player-next scenarios of the console feature (R4), picked up by scripts/e2e-player-next.mjs.
// Driven only through data-testid hooks; archive data correctness is covered by player-sdk tests.

const POLL_MS = 100;
const TIMEOUT_MS = 8_000;

/** Polls a page expression until it returns a truthy value. */
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

const rowsWith = (ctx, text) =>
  `[...document.querySelectorAll('${ctx.testId("console-row")}')].filter((row) => row.textContent.includes(${JSON.stringify(text)}))`;

/** A logged error opens in place: symbolicated frames, the source line, Original ↔ Minified. */
async function symbolicatedStack(ctx) {
  await ctx.openSynthetic({ hash: "#tab=console" });
  await ctx.waitForSelector(ctx.testId("console-list"), "The Console tab did not open");
  await ctx.evaluate(`${rowsWith(ctx, "AuthError")}.at(-1).click()`);
  const status = await waitForValue(
    ctx,
    `document.querySelector('${ctx.testId("stack-status")}')?.textContent.includes("Symbolicated") && document.querySelector('${ctx.testId("stack-status")}').textContent`,
    "The stack was not symbolicated with the map embedded in the archive"
  );
  const top = await ctx.evaluate(
    `document.querySelector('${ctx.testId("stack-frame")}').textContent`
  );
  ctx.assert(top.includes("ensure-casino-user.ts:57:11"), "The top frame is not mapped", { top });
  // Shiki (JavaScript regex engine, own chunk) highlights the snippet under the strict CSP.
  await ctx.waitForSelector(
    `${ctx.testId("stack-snippet")}[data-highlighted="true"]`,
    "The source snippet was not highlighted"
  );
  await ctx.click("stack-mode-minified");
  const minified = await waitForValue(
    ctx,
    `(() => { const text = document.querySelector('${ctx.testId("stack-frame")}').textContent; return text.includes("main.js:1:20412") && text; })()`,
    "Minified did not show the recorded frame"
  );
  await ctx.click("stack-mode-original");
  return { status, top, minified };
}

/** Level chips narrow the list; "Hide third-party" is on by default with a hidden count. */
async function levelsAndThirdParty(ctx) {
  await ctx.openSynthetic({ hash: "#tab=console" });
  await ctx.waitForSelector(ctx.testId("console-list"), "The Console tab did not open");
  const count = () =>
    ctx.evaluate(`document.querySelectorAll('${ctx.testId("console-row")}').length`);
  const initial = await count();
  const hidden = await ctx.evaluate(
    `document.querySelector('${ctx.testId("console-hidden-count")}')?.textContent ?? ""`
  );
  ctx.assert(hidden.includes("hidden"), "No hidden third-party count", { hidden });

  await ctx.click("console-hide-third-party");
  await waitForValue(
    ctx,
    `document.querySelectorAll('${ctx.testId("console-row")}').length > ${initial}`,
    "Showing third-party rows did not add rows"
  );
  await ctx.click("console-level-error");
  const onlyErrors = await waitForValue(
    ctx,
    `(() => { const rows = [...document.querySelectorAll('${ctx.testId("console-row")}')]; return rows.length > 0 && rows.every((row) => row.dataset.level === "error") && rows.length; })()`,
    "The Errors chip did not narrow the list to errors"
  );
  await ctx.click("console-level-error");
  await ctx.click("console-hide-third-party");
  return { initial, onlyErrors, hidden };
}

/** "Open request" on a resource error selects the request and switches to Network. */
async function openRelatedRequest(ctx) {
  await ctx.openSynthetic({ hash: "#tab=console" });
  await ctx.waitForSelector(ctx.testId("console-list"), "The Console tab did not open");
  await ctx.click("console-hide-third-party");
  await waitForValue(
    ctx,
    `${rowsWith(ctx, "ERR_ADDRESS_INVALID")}.length > 0`,
    "No resource error row"
  );
  await ctx.evaluate(`${rowsWith(ctx, "ERR_ADDRESS_INVALID")}[0].click()`);
  await ctx.waitForSelector(ctx.testId("open-request"), "The row has no Open request action");
  await ctx.click("open-request");
  await waitForValue(
    ctx,
    `document.querySelector('${ctx.testId("tab-network")}').getAttribute("aria-selected") === "true"`,
    "Open request did not switch to the Network tab"
  );
  const hash = await waitForValue(
    ctx,
    `location.hash.includes("sel=req") && location.hash`,
    "The request did not become the selection"
  );
  return { hash };
}

export default {
  feature: "console",
  scenarios: [
    { name: "open a logged error with its symbolicated stack", run: symbolicatedStack },
    { name: "level chips and hide third-party", run: levelsAndThirdParty },
    { name: "open the request a console error is about", run: openRelatedRequest }
  ]
};
