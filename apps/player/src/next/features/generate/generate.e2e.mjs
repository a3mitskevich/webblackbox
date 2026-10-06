// e2e:player-next scenarios of the Generate feature (R5), picked up by scripts/e2e-player-next.mjs.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const POLL_MS = 100;
const TIMEOUT_MS = 10_000;

/** Polls the text of `selector` until it contains `text`. */
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

async function openMenuItem(ctx, item) {
  await ctx.click("generate-button");
  await ctx.waitForSelector(ctx.testId(item), "The Generate menu did not open");
  await ctx.click(item);
}

/** `[` / `]` set the range at the playhead; the Playwright test is framed by it and copies. */
async function playwrightForRange(ctx) {
  await ctx.openSynthetic();
  await ctx.client.send("Browser.grantPermissions", {
    origin: ctx.origin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"]
  });

  await ctx.press("ArrowRight", { code: "ArrowRight" });
  await ctx.press("ArrowRight", { code: "ArrowRight" });
  await ctx.press("[", { code: "BracketLeft" });
  await ctx.press("ArrowRight", { code: "ArrowRight" });
  await ctx.press("ArrowRight", { code: "ArrowRight" });
  await ctx.press("ArrowRight", { code: "ArrowRight" });
  await ctx.press("]", { code: "BracketRight" });

  await ctx.click("generate-button");
  const menuRange = await waitForText(
    ctx,
    ctx.testId("generate-menu-range"),
    "0:02.00 – 0:05.00",
    "The menu does not show the timeline range"
  );
  await ctx.click("generate-playwright");
  await ctx.waitForSelector(ctx.testId("generate-dialog-playwright"), "No Playwright dialog");
  await waitForText(
    ctx,
    ctx.testId("generate-range-summary"),
    "0:02.00 – 0:05.00",
    "The dialog did not start from the timeline range"
  );
  await waitForText(ctx, ctx.testId("generate-preview"), "page.goto(", "No Playwright preview");
  const startUrl = await ctx.evaluate(
    `document.querySelector('${ctx.testId("generate-start-url")}').textContent`
  );

  await ctx.click("generate-copy");
  const status = await waitForText(
    ctx,
    ctx.testId("generate-copy-status"),
    "Copied",
    "The script was not copied"
  );
  const clipboard = String(await ctx.evaluate("navigator.clipboard.readText()"));
  ctx.assert(
    clipboard.includes("import { test } from '@playwright/test';") &&
      clipboard.includes("page.goto("),
    "The clipboard has no Playwright test",
    clipboard.slice(0, 200)
  );

  await ctx.click("generate-close");
  return { menuRange, startUrl, status, lines: clipboard.split("\n").length };
}

/** The bug report previews as highlighted Markdown under the strict CSP (Shiki, no WASM). */
async function bugReport(ctx) {
  await ctx.openSynthetic();
  await openMenuItem(ctx, "generate-bug-report");
  await ctx.waitForSelector(ctx.testId("generate-dialog-bug-report"), "No bug report dialog");
  await waitForText(
    ctx,
    ctx.testId("generate-preview"),
    "# WebBlackbox Bug Report",
    "No bug report preview"
  );
  const origin = await waitForText(
    ctx,
    ctx.testId("generate-preview"),
    "https://app.example.test",
    "The report does not name the session origin"
  );
  const highlighted = await ctx.evaluate(
    `(async () => {
      for (let i = 0; i < 50; i += 1) {
        if (document.querySelector('${ctx.testId("generate-preview")}').dataset.highlighted === "true") return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    })()`
  );
  ctx.assert(highlighted, "The Markdown preview was not highlighted");
  return { highlighted, length: origin.length };
}

/** The HAR file of the session downloads under its classic name. */
async function harDownload(ctx) {
  await ctx.openSynthetic();
  const downloadPath = join(ctx.artifactsDir, "downloads");
  await mkdir(downloadPath, { recursive: true });
  const downloads = [];
  ctx.client.on("Browser.downloadWillBegin", (event) => downloads.push(event.suggestedFilename));
  ctx.client.on("Page.downloadWillBegin", (event) => downloads.push(event.suggestedFilename));
  await ctx.client.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath,
    eventsEnabled: true
  });

  await openMenuItem(ctx, "generate-har");
  const summary = await waitForText(
    ctx,
    ctx.testId("generate-har-summary"),
    "requests",
    "No HAR summary"
  );
  await ctx.click("generate-download");
  await waitForText(
    ctx,
    ctx.testId("generate-download-status"),
    "Saved webblackbox-session.har",
    "The HAR was not saved"
  );

  const deadline = Date.now() + TIMEOUT_MS;

  while (!downloads.includes("webblackbox-session.har") && Date.now() < deadline) {
    await ctx.sleep(POLL_MS);
  }

  ctx.assert(
    downloads.includes("webblackbox-session.har"),
    "The browser did not start the HAR download",
    downloads
  );
  return { summary, downloads };
}

export default {
  feature: "generate",
  scenarios: [
    { name: "Playwright test for a range set with [ and ], copied", run: playwrightForRange },
    { name: "bug report preview (highlighted Markdown)", run: bugReport },
    { name: "download the HAR file", run: harDownload }
  ]
};
