// e2e:player-next scenarios of the perf feature (R4), picked up by scripts/e2e-player-next.mjs.

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

/** uPlot draws both charts on canvas under the strict CSP; clicking a chart seeks. */
async function chartsDrawAndSeek(ctx) {
  await ctx.openSynthetic({ hash: "#t=12&tab=perf" });
  await ctx.waitForSelector(ctx.testId("perf-panel"), "The Perf tab did not open");
  const canvases = await waitForValue(
    ctx,
    `document.querySelectorAll('${ctx.testId("perf-panel")} canvas').length >= 2 && document.querySelectorAll('${ctx.testId("perf-panel")} canvas').length`,
    "uPlot did not draw the charts"
  );
  const lcp = await ctx.evaluate(
    `document.querySelector('${ctx.testId("perf-vital-lcp")}').dataset.rating`
  );
  ctx.assert(lcp === "good", "LCP at 0:12 is not rated good", { lcp });

  const before = await ctx.evaluate(`document.querySelector('${ctx.testId("clock")}').textContent`);
  const box = await ctx.evaluate(`(() => {
    const rect = document.querySelector('${ctx.testId("perf-chart-network")} .u-over').getBoundingClientRect();
    return { x: rect.left + rect.width * 0.25, y: rect.top + rect.height / 2 };
  })()`);
  await ctx.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await ctx.client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: box.x,
    y: box.y,
    button: "left",
    clickCount: 1
  });
  await ctx.client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: box.x,
    y: box.y,
    button: "left",
    clickCount: 1
  });
  const after = await waitForValue(
    ctx,
    `(() => { const text = document.querySelector('${ctx.testId("clock")}').textContent; return text !== ${JSON.stringify(before)} && text; })()`,
    "Clicking the chart did not seek"
  );
  return { canvases, before, after };
}

export default {
  feature: "perf",
  scenarios: [{ name: "charts draw on canvas and seek", run: chartsDrawAndSeek }]
};
