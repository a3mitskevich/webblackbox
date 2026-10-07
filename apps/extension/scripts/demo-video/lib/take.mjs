// One take: start servers and helpers, let the scenario prepare the desktop off camera, record the
// demo window while the steps run (captions are marked as they appear), then encode the final
// video with burned-in captions and copy it to the review folder.
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cuesFromMarks, readingTimeMs } from "./captions.mjs";
import { closeChrome } from "./browser.mjs";
import { DEMO_CONFIG } from "./config.mjs";
import { createContext } from "./context.mjs";
import { startDemoServers } from "./demo-server.mjs";
import { probeDurationMs, renderFinal, startCapture } from "./recorder.mjs";
import { AbortedError, installHelpers, startAgent, startWatchdog, toWinPath } from "./windows.mjs";

const TAIL_MS = 1200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ scenario: object, lang: string, log: (line: string) => void, keepRaw?: boolean,
 *   rehearsal?: boolean }} options  `rehearsal` runs the steps without recording.
 */
export async function runTake({ scenario, lang, log, keepRaw = false, rehearsal = false }) {
  const config = DEMO_CONFIG;
  mkdirSync(config.outputDir, { recursive: true });
  mkdirSync(config.workDirWsl, { recursive: true });
  const script = installHelpers(config.workDirWsl);
  let abortReason = null;
  const resources = [];
  const marks = [];
  const rawWsl = join(config.workDirWsl, "raw", `${scenario.id}.${lang}.mkv`);
  mkdirSync(join(config.workDirWsl, "raw"), { recursive: true });
  let capture = null;
  let ctx = null;
  let hardStop = null;
  const checkAbort = () => {
    if (abortReason) throw new AbortedError(abortReason);
  };

  try {
    const watchdog = await startWatchdog(script, (reason) => {
      abortReason = reason;
      log(`ABORT requested (${reason})`);
    });
    resources.push(async () => watchdog.close());
    const agent = await startAgent(script, log);
    resources.push(() => agent.close());
    await agent.call("resetAbort");
    const servers = await startDemoServers({
      demoPort: config.demoPort,
      playerPort: config.playerPort,
      playerDir: config.playerDir
    });
    resources.push(() => servers.close());
    ctx = createContext({ agent, config, lang, servers, log });
    hardStop = setTimeout(() => {
      abortReason = abortReason ?? "take timeout";
      log("take hit its hard timeout");
    }, config.takeTimeoutMs);

    log(`prepare ${scenario.id} (${lang})`);
    await scenario.prepare(ctx);
    checkAbort();
    // The scenario's prepare leaves the window it starts with in front (Chrome or Explorer).
    if (!rehearsal) {
      const rect = await ctx.captureRect();
      capture = await startCapture({ rect, outWin: toWinPath(rawWsl), log });
      ctx.setMarker((text) => marks.push({ atMs: Date.now() - capture.t0, text }));
    }
    let shownAt = 0;
    let shownText = "";
    for (const step of scenario.steps) {
      checkAbort();
      if (step.say) {
        const text = step.say[lang];
        const wait = shownText ? shownAt + readingTimeMs(shownText) - Date.now() : 0;
        if (wait > 0) await sleep(wait);
        ctx.mark(text);
        log(`  [${step.id}] ${text}`);
        shownAt = Date.now();
        shownText = text;
      } else {
        log(`  [${step.id}]`);
      }
      if (step.run) await step.run(ctx);
    }
    const tail = shownAt + readingTimeMs(shownText) - Date.now();
    await sleep(Math.max(tail, 0) + TAIL_MS);
    checkAbort();
  } catch (error) {
    if (abortReason && !(error instanceof AbortedError)) throw new AbortedError(abortReason);
    throw error;
  } finally {
    clearTimeout(hardStop);
    await capture?.stop().catch(() => undefined);
    if (ctx) {
      await ctx.agent.call("release").catch(() => undefined);
      await scenario.cleanup?.(ctx).catch((error) => log(`cleanup: ${error.message}`));
      if (ctx.chrome) await closeChrome(ctx.chrome).catch(() => undefined);
    }
    for (const release of resources.reverse()) await release().catch(() => undefined);
  }

  if (rehearsal) return null;
  const durationMs = await probeDurationMs(rawWsl);
  const cues = cuesFromMarks(marks, durationMs);
  const base = `${scenario.id}.${lang}`;
  const outWsl = join(config.outputDir, `${base}.mp4`);
  writeFileSync(join(config.outputDir, `${base}.marks.json`), JSON.stringify(marks, null, 2));
  log(`render ${outWsl}`);
  await renderFinal({
    rawWsl,
    assWsl: join(config.outputDir, `${base}.ass`),
    outWsl,
    cues,
    width: config.window.width,
    height: config.window.height,
    title: scenario.title[lang]
  });
  mkdirSync(config.reviewDirWsl, { recursive: true });
  const reviewWsl = join(config.reviewDirWsl, `${base}.mp4`);
  copyFileSync(outWsl, reviewWsl);
  if (!keepRaw) rmSync(rawWsl, { force: true });
  return { outWsl, reviewWin: toWinPath(reviewWsl), durationMs };
}
