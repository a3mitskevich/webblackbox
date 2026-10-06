// e2e:player scenarios of the event inspector (R5), picked up by scripts/e2e-player.mjs.

const POLL_MS = 100;
const TIMEOUT_MS = 10_000;

async function waitForText(ctx, selector, text, message) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last = null;

  while (Date.now() < deadline) {
    last = await ctx.evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`
    );

    if (typeof last === "string" && last.includes(text)) {
      return last;
    }

    await ctx.sleep(POLL_MS);
  }

  throw new Error(`${message} | last=${JSON.stringify(last)}`);
}

const text = (ctx, id) =>
  ctx.evaluate(`document.querySelector('${ctx.testId(id)}')?.textContent ?? ""`);

/** The lobby click (action A-000002) at its moment, opened with Enter. */
async function openLobbyClick(ctx) {
  await ctx.openSynthetic({ hash: "#t=10.80&sel=act:A-000002&tab=activity" });
  await ctx.evaluate(`document.querySelector('${ctx.testId("event-list")}').focus()`);
  await ctx.press("Enter", { code: "Enter", keyCode: 13 });
  await ctx.waitForSelector(ctx.testId("inspector"), "Enter did not open the inspector");
}

/**
 * The click's target (selector, box outlined on the video), what it caused (counts and the 401s)
 * and a one-line summary.
 */
async function inspectClick(ctx) {
  await openLobbyClick(ctx);
  const title = await waitForText(
    ctx,
    ctx.testId("inspector-title"),
    "Live table 64",
    "The inspector title does not name the click target"
  );
  const summary = await text(ctx, "inspector-summary");
  ctx.assert(
    summary.startsWith("The user clicked “Live table 64” on #/lobby.") &&
      /requests failed; the first, 401 GET/.test(summary),
    "The summary does not say what the user did and what failed",
    { summary }
  );
  const selector = await text(ctx, "inspector-selector");
  ctx.assert(selector === "#lobbyGame_64 picture > img", "Wrong target selector", { selector });

  const consequences = await ctx.evaluate(
    `[...document.querySelectorAll('${ctx.testId("inspector-consequence")}')].map((item) => item.textContent)`
  );
  ctx.assert(
    consequences.some((item) => item.includes("401")),
    "What it caused lists no 401",
    { consequences }
  );

  // The target is outlined on the frame at the click's moment, inside the frame.
  await ctx.waitForSelector(ctx.testId("target-frame"), "The target is not outlined on the video");
  const outline = await ctx.evaluate(`(() => {
    const frame = document.querySelector('${ctx.testId("stage-frame")}').getBoundingClientRect();
    const box = document.querySelector('${ctx.testId("target-frame")}').getBoundingClientRect();
    return { inside: box.left >= frame.left - 1 && box.right <= frame.right + 1 &&
      box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1, width: box.width };
  })()`);
  ctx.assert(outline.inside && outline.width > 4, "The outline is not on the frame", outline);

  return { title, consequences: consequences.length };
}

/** Copy step, then "Playwright from …" opens the Generate dialog framed by the action. */
async function reproduceFromInspector(ctx) {
  await openLobbyClick(ctx);
  await ctx.client.send("Browser.grantPermissions", {
    origin: ctx.origin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"]
  });

  await ctx.click("inspector-copy-step");
  await waitForText(ctx, ctx.testId("inspector-copy-step-status"), "Copied", "Step not copied");
  const clipboard = String(await ctx.evaluate("navigator.clipboard.readText()"));
  ctx.assert(clipboard.includes("#lobbyGame_64 picture > img"), "Wrong step copied", { clipboard });

  await ctx.click("inspector-playwright");
  await ctx.waitForSelector(ctx.testId("generate-dialog-playwright"), "No Playwright dialog");
  const range = await text(ctx, "generate-range-summary");
  ctx.assert(/0:0\d\.\d\d – 0:1\d\.\d\d/.test(range), "The test is not framed by the action", {
    range
  });
  await ctx.press("Escape", { code: "Escape", keyCode: 27 });
  return { clipboard: clipboard.trim(), range };
}

/** J / L follow the list inside the inspector; Esc returns to the list with the focus on it. */
async function stepAndReturn(ctx) {
  await openLobbyClick(ctx);
  const before = await text(ctx, "inspector-meta");
  await ctx.press("l", { code: "KeyL" });
  const deadline = Date.now() + TIMEOUT_MS;
  let after = before;

  while (Date.now() < deadline && after === before) {
    await ctx.sleep(POLL_MS);
    after = await text(ctx, "inspector-meta");
  }

  ctx.assert(after !== before, "L did not move the inspector to the next event", { before });

  await ctx.press("Escape", { code: "Escape", keyCode: 27 });
  await ctx.waitForSelector(ctx.testId("event-list"), "Esc did not return to the list");
  const focused = await ctx.evaluate(
    `document.activeElement === document.querySelector('${ctx.testId("event-list")}')`
  );
  ctx.assert(focused, "The list did not get the focus back");
  return { before, after };
}

export default {
  feature: "inspector",
  scenarios: [
    { name: "inspect a click: target on the video, what it caused, summary", run: inspectClick },
    { name: "copy the step and generate Playwright from the action", run: reproduceFromInspector },
    { name: "J / L inside the inspector, Esc back to the list", run: stepAndReturn }
  ]
};
