// e2e:player scenarios of the compare feature (R4), picked up by scripts/e2e-player.mjs.
// Session B is the synthetic recording with one regressed endpoint, written next to the artifacts.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildCompareVariant } from "../../../../scripts/lib/synthetic-signals.mjs";
import {
  buildSyntheticSession,
  createPlainArchive,
  sha256Hex
} from "../../../../scripts/lib/synthetic-session.mjs";

const POLL_MS = 100;
const TIMEOUT_MS = 10_000;

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

async function chooseFile(ctx, testIdName, path) {
  const { result } = await ctx.client.send("Runtime.evaluate", {
    expression: `document.querySelector('${ctx.testId(testIdName)}')`
  });

  if (!result?.objectId) {
    throw new Error(`${testIdName} not found`);
  }

  await ctx.client.send("DOM.setFileInputFiles", { files: [path], objectId: result.objectId });
}

/** Open archive B: deltas, the regressed endpoint and its response diff (lazy jsdiff chunk). */
async function compareWithAnotherRecording(ctx) {
  const path = join(ctx.artifactsDir, "compare-b.webblackbox");
  await writeFile(
    path,
    await createPlainArchive(buildCompareVariant(buildSyntheticSession(), sha256Hex))
  );

  await ctx.openSynthetic({ hash: "#tab=compare" });
  await ctx.waitForSelector(ctx.testId("compare-empty"), "The Compare tab did not open");
  await chooseFile(ctx, "compare-input", path);
  await ctx.waitForSelector(ctx.testId("compare-report"), "Session B did not load");
  const signals = await ctx.evaluate(
    `[...document.querySelectorAll('${ctx.testId("compare-endpoint-row")}')].map((row) => row.dataset.signal)`
  );
  ctx.assert(signals.includes("regressed") && signals.includes("new"), "Missing endpoint signals", {
    signals
  });

  await ctx.evaluate(
    `[...document.querySelectorAll('${ctx.testId("compare-endpoint-row")}')].find((row) => row.dataset.signal === "regressed").click()`
  );
  const diff = await waitForValue(
    ctx,
    `document.querySelector('${ctx.testId("compare-body-diff")}')?.textContent.includes('"status": "closed"') && document.querySelectorAll('${ctx.testId("compare-body-diff")} [data-kind="add"]').length`,
    "The response diff of the regressed endpoint did not show"
  );
  const errorsDelta = await ctx.evaluate(
    `document.querySelector('${ctx.testId("compare-delta-errors")}').textContent`
  );
  await ctx.click("compare-clear");
  await ctx.waitForSelector(ctx.testId("compare-empty"), "Stop comparing did not clear session B");
  return { signals: signals.length, addedLines: diff, errorsDelta };
}

export default {
  feature: "compare",
  scenarios: [{ name: "compare with another recording", run: compareWithAnotherRecording }]
};
