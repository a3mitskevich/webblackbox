// e2e:player scenarios of the R5 shell tools: the timeline range and "Expand lanes", the command
// palette and "About this recording". Run with the shell scenarios (whatever the feature filter).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const POLL_MS = 100;
const TIMEOUT_MS = 10_000;

async function waitFor(ctx, read, accept, message) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last = null;

  while (Date.now() < deadline) {
    last = await read();

    if (accept(last)) {
      return last;
    }

    await ctx.sleep(POLL_MS);
  }

  throw new Error(`${message} | last=${JSON.stringify(last)}`);
}

const textOf = (ctx, id) =>
  ctx.evaluate(`document.querySelector('${ctx.testId(id)}')?.textContent ?? null`);
const count = (ctx, id) => ctx.evaluate(`document.querySelectorAll('${ctx.testId(id)}').length`);

/** Shift+drag on the scrubber from one share of the track to another. */
async function shiftDrag(ctx, fromRatio, toRatio) {
  const box = await ctx.evaluate(`(() => {
    const track = document.querySelector('${ctx.testId("lane-errors")}').getBoundingClientRect();
    return { left: track.left, width: track.width, y: track.top + track.height / 2 };
  })()`);
  const at = (ratio) => box.left + box.width * ratio;
  const SHIFT = 8;

  await ctx.client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: at(fromRatio),
    y: box.y,
    button: "left",
    clickCount: 1,
    modifiers: SHIFT
  });

  for (let step = 1; step <= 6; step += 1) {
    await ctx.client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: at(fromRatio + ((toRatio - fromRatio) * step) / 6),
      y: box.y,
      button: "left",
      buttons: 1,
      modifiers: SHIFT
    });
  }

  await ctx.client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: at(toRatio),
    y: box.y,
    button: "left",
    clickCount: 1,
    modifiers: SHIFT
  });
}

/** Shift+drag selects a range: the chip shows it, the lists narrow to it, × clears it. */
async function timelineRange(ctx) {
  await ctx.openSynthetic();
  const before = await ctx.snapshot();
  await shiftDrag(ctx, 0.5, 0.75);
  const chip = await waitFor(
    ctx,
    () => textOf(ctx, "range-chip"),
    (value) => typeof value === "string" && value.startsWith("Range "),
    "Shift+drag selected no range"
  );
  const [startText, endText] = chip.slice("Range ".length).split(" – ");
  const seconds = (clock) => {
    const [minutes, rest] = clock.split(":");
    return Number(minutes) * 60 + Number(rest);
  };
  const times = await waitFor(
    ctx,
    () =>
      ctx.evaluate(
        `[...document.querySelectorAll('${ctx.testId("event-row")}')].map((row) => Number(row.querySelector("time").textContent))`
      ),
    (values) =>
      Array.isArray(values) &&
      values.length > 0 &&
      values.every(
        (value) => value >= seconds(startText) - 0.01 && value <= seconds(endText) + 0.01
      ),
    "The Activity list shows rows outside the range"
  );
  const during = await ctx.snapshot();
  ctx.assert(during.clock === before.clock, "Shift+drag moved the playhead", { before, during });

  await ctx.click("range-clear");
  await waitFor(
    ctx,
    () => count(ctx, "range-chip"),
    (value) => value === 0,
    "× kept the range"
  );
  return { chip, rows: times.length };
}

/** "Expand lanes" adds navigation, console, storage, pointer and filmstrip lanes; a frame seeks. */
async function expandLanes(ctx) {
  await ctx.openSynthetic();
  await ctx.click("expand-lanes");
  for (const lane of ["navigation", "console", "storage", "pointer", "filmstrip"]) {
    await ctx.waitForSelector(ctx.testId(`lane-${lane}`), `No ${lane} lane`);
  }

  const frames = await count(ctx, "filmstrip-frame");
  ctx.assert(frames > 0, "The filmstrip has no frames");
  const before = (await ctx.snapshot()).clock;
  await ctx.evaluate(
    `[...document.querySelectorAll('${ctx.testId("filmstrip-frame")}')].at(-1).click()`
  );
  const after = await waitFor(
    ctx,
    async () => (await ctx.snapshot()).clock,
    (value) => value !== before,
    "A filmstrip frame did not seek"
  );
  await ctx.click("expand-lanes");
  return { frames, before, after };
}

/** Ctrl+K: type a URL, Enter opens the request in the Network tab. */
async function commandPalette(ctx) {
  await ctx.openSynthetic();
  await ctx.press("k", { code: "KeyK", modifiers: 2 });
  await ctx.waitForSelector(ctx.testId("command-palette"), "Ctrl+K did not open the palette");
  await ctx.client.send("Input.insertText", { text: "casino-user" });
  await waitFor(
    ctx,
    () =>
      ctx.evaluate(
        `[...document.querySelectorAll('${ctx.testId("palette-item")}')].map((item) => item.dataset.itemId)`
      ),
    (ids) => Array.isArray(ids) && ids.includes("req-90080.1706"),
    "The palette did not find the request"
  );
  await ctx.evaluate(
    `document.querySelector('${ctx.testId("palette-item")}[data-item-id="req-90080.1706"]').click()`
  );
  const tab = await waitFor(
    ctx,
    async () => (await ctx.snapshot()).tab,
    (value) => value === "tab-network",
    "The request did not open in the Network tab"
  );
  await waitFor(
    ctx,
    () => count(ctx, "command-palette"),
    (value) => value === 0,
    "Still open"
  );
  return { tab };
}

/** The session block opens "About this recording" with what the archive contains. */
async function aboutRecording(ctx) {
  await ctx.openSynthetic();
  await ctx.click("session");
  await ctx.waitForSelector(ctx.testId("archive-info"), "No About this recording dialog");
  const statuses = await ctx.evaluate(`Object.fromEntries(
    [...document.querySelectorAll('[data-testid^="contents-"]')].map((item) => [
      item.dataset.testid.slice("contents-".length),
      item.dataset.status
    ])
  )`);
  ctx.assert(
    statuses.network !== "none" && statuses.realtime !== "none" && statuses.console !== "none",
    "The synthetic archive's network, sockets and console are not listed",
    statuses
  );
  await ctx.press("Escape", { code: "Escape", keyCode: 27 });
  await waitFor(
    ctx,
    () => count(ctx, "archive-info"),
    (value) => value === 0,
    "Esc kept it open"
  );
  return statuses;
}

export const TOOL_SCENARIOS = {
  feature: "shell",
  scenarios: [
    { name: "timeline range filters the lists", run: timelineRange },
    { name: "expand lanes and the filmstrip", run: expandLanes },
    { name: "command palette finds a request", run: commandPalette },
    { name: "about this recording", run: aboutRecording }
  ]
};

const AXE_SOURCE = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8"
);
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * WCAG 1.4.10 reflow: nothing scrolls the page sideways, and no rail panel is wider than the rail
 * (a long unbreakable selector once widened the inspector to ~2,000 px).
 */
async function overflowViolations(ctx, state) {
  const widths = await ctx.evaluate(`(() => {
    const page = document.scrollingElement;
    const rail = document.querySelector('${ctx.testId("rail")}');
    const panel = rail?.querySelector('.rail-panel:not([hidden])');
    return {
      page: page.scrollWidth - page.clientWidth,
      panel: panel && rail ? Math.round(panel.getBoundingClientRect().width - rail.clientWidth) : 0
    };
  })()`);
  return widths.page > 0 || widths.panel > 1
    ? [{ state, id: "horizontal-overflow", impact: "serious", nodes: [JSON.stringify(widths)] }]
    : [];
}

/** axe-core on the current page: serious and critical WCAG A/AA violations. */
async function axeViolations(ctx, state) {
  const overflow = await overflowViolations(ctx, state);
  // DevTools evaluation is not subject to the page CSP; the Player never loads axe itself.
  if (!(await ctx.evaluate("Boolean(window.axe)"))) {
    await ctx.evaluate(AXE_SOURCE);
  }

  // Expanded lanes keep one mark per 24 px slot, but marks in neighbouring slots (and the action
  // lane) may still sit closer than 24 px; WCAG 2.5.8 lets them, because the Activity list offers
  // the same function at full size (the "equivalent" exception). Every other rule checks them.
  // axe runs one audit at a time.
  const result = await ctx.evaluate(`axe
    .run(document, {
      runOnly: { type: "tag", values: ${JSON.stringify(AXE_TAGS)} },
      rules: { "target-size": { enabled: false } }
    })
    .then((all) =>
      axe
        .run({ exclude: [[".tl-track.marks"]] }, { runOnly: { type: "rule", values: ["target-size"] } })
        .then((targets) => [...all.violations, ...targets.violations])
    )
    .then((violations) => violations
      .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
      .map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.slice(0, 4).map((node) => node.target.join(" ") + " :: " + node.failureSummary.split("\\n")[1] + " :: " + node.html.slice(0, 160))
      })))`);
  return [...overflow, ...result.map((violation) => ({ state, ...violation }))];
}

/**
 * Accessibility pass (PROPOSAL §7): axe-core finds no serious or critical WCAG 2.2 A/AA problem in
 * the loaded player (light and dark), the event inspector, "About this recording" and the palette.
 */
async function accessibilityScan(ctx) {
  const violations = [];

  for (const theme of ["light", "dark"]) {
    await ctx.client.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: theme }]
    });
    await ctx.openSynthetic({ hash: "#t=10.89&sel=req:90080.1706" });
    await ctx.sleep(300);
    violations.push(...(await axeViolations(ctx, `${theme}: loaded`)));

    await ctx.openSynthetic({ hash: "#t=10.80&sel=act:A-000002&tab=activity" });
    await ctx.evaluate(`document.querySelector('${ctx.testId("event-list")}').focus()`);
    await ctx.press("Enter", { code: "Enter", keyCode: 13 });
    await ctx.waitForSelector(ctx.testId("inspector"), "No inspector");
    await ctx.sleep(300);
    violations.push(...(await axeViolations(ctx, `${theme}: inspector`)));
  }

  await ctx.client.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }]
  });
  await ctx.openSynthetic();
  await ctx.click("session");
  await ctx.waitForSelector(ctx.testId("archive-info"), "No About dialog");
  await ctx.sleep(300);
  violations.push(...(await axeViolations(ctx, "about this recording")));
  await ctx.press("Escape", { code: "Escape", keyCode: 27 });
  await waitFor(
    ctx,
    () => count(ctx, "archive-info"),
    (value) => value === 0,
    "About stayed open"
  );

  await ctx.press("k", { code: "KeyK", modifiers: 2 });
  await ctx.waitForSelector(ctx.testId("command-palette"), "No palette");
  await ctx.client.send("Input.insertText", { text: "casino" });
  await ctx.sleep(400);
  violations.push(...(await axeViolations(ctx, "command palette")));
  await ctx.press("Escape", { code: "Escape", keyCode: 27 });
  await waitFor(
    ctx,
    () => count(ctx, "command-palette"),
    (value) => value === 0,
    "Palette open"
  );

  await ctx.click("expand-lanes");
  await ctx.press("[", { code: "BracketLeft" });
  await ctx.waitForSelector(ctx.testId("range-chip"), "No range");
  violations.push(...(await axeViolations(ctx, "expanded lanes and a range")));

  await ctx.click("generate-button");
  await ctx.waitForSelector(ctx.testId("generate-playwright"), "No Generate menu");
  await ctx.click("generate-playwright");
  await ctx.waitForSelector(ctx.testId("generate-preview"), "No Playwright preview");
  await ctx.sleep(500);
  violations.push(...(await axeViolations(ctx, "generate: Playwright dialog")));
  await ctx.press("Escape", { code: "Escape", keyCode: 27 });

  ctx.assert(violations.length === 0, "axe-core found accessibility violations", violations);
  return { states: 8, violations: 0 };
}

TOOL_SCENARIOS.scenarios.push({
  name: "accessibility (axe-core, WCAG 2.2 AA)",
  run: accessibilityScan
});
