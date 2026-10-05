// Optional passes of e2e:player-next: before/after screenshots (WB_E2E_SCREENSHOTS_DIR) and a
// real archive (WB_E2E_REAL_ARCHIVE; its screenshots stay local, never commit them).
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { sleep, waitFor } from "../lib/cdp-harness.mjs";
import {
  navigateFresh,
  openEncrypted,
  press,
  screenshot,
  setViewport,
  waitForSelector,
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
      await client.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: "light" }]
      });
      await client.send("Page.navigate", { url: `${origin}/?lang=${lang}` });
      await waitForSelector(client, "#archive-input", 20_000, "Classic player did not start");
      await setClassicFile(client, archivePath);
      await waitForSelector(
        client,
        "#archive-passphrase-dialog[open]",
        15_000,
        "Classic passphrase dialog did not open"
      );
      await client.evaluate("document.querySelector('#archive-passphrase-input').focus()");
      await client.send("Input.insertText", { text: SYNTHETIC_PASSPHRASE });
      await client.evaluate("document.querySelector('#archive-passphrase-confirm').click()");
      await waitFor(
        async () =>
          (await client.evaluate(`document.querySelectorAll('#timeline-list .event').length > 0`))
            ? true
            : null,
        20_000,
        150,
        "Classic player did not load"
      );
      await sleep(400);
      shots.push(await screenshot(client, outDir, `before-classic-${width}-light-${lang}.png`));

      for (const theme of ["light", "dark"]) {
        // The shot is taken at the first 401 (t=10.89); waitForSnapshot below checks the clock.
        // Default theme and splitter sizes: earlier scenarios may have stored others.
        await client.evaluate(
          "Object.keys(localStorage).filter((key) => key === 'webblackbox.player.theme' || key.startsWith('react-resizable-panels:')).forEach((key) => localStorage.removeItem(key))"
        );
        await client.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: theme }]
        });
        await navigateFresh(client, `${origin}/?ui=next&lang=${lang}#t=10.89&sel=req:90080.1706`);
        await openEncrypted(client, archivePath, SYNTHETIC_PASSPHRASE);
        await waitForSnapshot(
          client,
          (value) => value.media === "screenshot" && /0:10[.,]89/.test(value.clock),
          "Stage did not show the screenshot at 10.89 s"
        );
        await client.evaluate("document.fonts.ready");
        await sleep(400);
        shots.push(await screenshot(client, outDir, `after-next-${width}-${theme}-${lang}.png`));
      }
    }
  }

  await setViewport(client, 390, 844);
  await client.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }]
  });
  await navigateFresh(client, `${origin}/?ui=next&lang=en#t=10.89&sel=req:90080.1706`);
  await openEncrypted(client, archivePath, SYNTHETIC_PASSPHRASE);
  await sleep(400);
  shots.push(await screenshot(client, outDir, "after-next-390-light-en.png"));
  await setViewport(client, 1440, 900);
  return shots;
}

export async function verifyRealArchive(client, origin, archivePath, passphrase, artifactsDir) {
  const outDir = resolve(artifactsDir, "real-archive");
  await mkdir(outDir, { recursive: true });
  await setViewport(client, 1440, 900);
  // Mid-session (the real recording has no frame at 0 s); the classic error rule finds no errors
  // in it (console errors carry data.level — R2), so the check seeks by the URL hash.
  await navigateFresh(client, `${origin}/?ui=next&lang=en#t=10.89`);
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
    screenshot: shot
  };
}

async function setClassicFile(client, archivePath) {
  const { result } = await client.send("Runtime.evaluate", {
    expression: "document.querySelector('#archive-input')"
  });
  await client.send("DOM.setFileInputFiles", { files: [archivePath], objectId: result.objectId });
  // setFileInputFiles fires `change` itself; a second event would start a second load.
}
