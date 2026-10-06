// Optional passes of e2e:player: screenshots (WB_E2E_SCREENSHOTS_DIR) and a
// real archive (WB_E2E_REAL_ARCHIVE; its screenshots stay local, never commit them).
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { sleep } from "../lib/cdp-harness.mjs";
import {
  assert,
  navigateFresh,
  openEncrypted,
  press,
  screenshot,
  setViewport,
  waitForSnapshot
} from "../lib/next-e2e.mjs";
import { SYNTHETIC_PASSPHRASE } from "../lib/synthetic-session.mjs";

export async function captureScreenshots(client, origin, archivePath, outDir) {
  await mkdir(outDir, { recursive: true });
  const shots = [];

  for (const [width, height] of [
    [1440, 900],
    [1920, 1080]
  ]) {
    await setViewport(client, width, height);

    for (const lang of ["en", "ru"]) {
      for (const theme of ["light", "dark"]) {
        // The shot is taken at the first 401 (t=10.89); waitForSnapshot below checks the clock.
        // Default theme and splitter sizes: earlier scenarios may have stored others.
        await client.evaluate(
          "Object.keys(localStorage).filter((key) => key === 'webblackbox.player.theme' || key.startsWith('react-resizable-panels:')).forEach((key) => localStorage.removeItem(key))"
        );
        await client.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: theme }]
        });
        await navigateFresh(client, `${origin}/?lang=${lang}#t=10.89&sel=req:90080.1706`);
        await openEncrypted(client, archivePath, SYNTHETIC_PASSPHRASE);
        await waitForSnapshot(
          client,
          (value) => value.media === "screenshot" && /0:10[.,]89/.test(value.clock),
          "Stage did not show the screenshot at 10.89 s"
        );
        await client.evaluate("document.fonts.ready");
        await sleep(400);
        shots.push(await screenshot(client, outDir, `player-${width}-${theme}-${lang}.png`));
      }
    }
  }

  await setViewport(client, 390, 844);
  await client.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }]
  });
  await navigateFresh(client, `${origin}/?lang=en#t=10.89&sel=req:90080.1706`);
  await openEncrypted(client, archivePath, SYNTHETIC_PASSPHRASE);
  await sleep(400);
  shots.push(await screenshot(client, outDir, "player-390-light-en.png"));
  await setViewport(client, 1440, 900);
  return shots;
}

export async function verifyRealArchive(client, origin, archivePath, passphrase, artifactsDir) {
  const outDir = resolve(artifactsDir, "real-archive");
  await mkdir(outDir, { recursive: true });
  await setViewport(client, 1440, 900);
  // Mid-session: the real recording has no frame at 0 s.
  await navigateFresh(client, `${origin}/?lang=en#t=10.89`);
  await openEncrypted(client, archivePath, passphrase);
  const snapshot = await waitForSnapshot(
    client,
    (value) => value.rows > 0 && value.media !== "none",
    "Real archive did not render",
    30_000
  );
  await press(client, "l");
  const stepped = await waitForSnapshot(
    client,
    (value) => value.selectedRow !== null,
    "L selected nothing"
  );
  // R2: failures are grouped in the problems strip and E reaches them (console errors by
  // data.level, failed requests).
  const problems = await client.evaluate(
    `[...document.querySelectorAll('[data-testid="problem-chip"]')].map((chip) => chip.textContent)`
  );
  assert(problems.length > 0, "The real archive shows no problems", problems);
  await press(client, "Home", { code: "Home", keyCode: 36 });
  await press(client, "e");
  const error = await waitForSnapshot(
    client,
    (value) => value.live.startsWith("Error 1 of") && value.selectedRow !== null,
    "E found no error in the real archive"
  );
  await sleep(800);
  const shot = await screenshot(client, outDir, "real-archive-1440.png");
  return {
    clock: snapshot.clock,
    chapters: snapshot.chapters,
    rows: snapshot.rows,
    media: snapshot.media,
    actionMarks: snapshot.actionMarks,
    networkBars: snapshot.networkBars,
    realtimeTicks: snapshot.realtimeTicks,
    stepped: stepped.live.slice(0, 80),
    problems,
    firstError: error.live.slice(0, 120),
    screenshot: shot
  };
}
