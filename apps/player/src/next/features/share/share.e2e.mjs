// e2e:player scenarios of the share feature (R4), picked up by scripts/e2e-player.mjs.
// The share server is stubbed inside the page (XMLHttpRequest for the upload, fetch for the
// archive), because the harness already owns the CDP Fetch domain for the strict-CSP pass.
import { readFile } from "node:fs/promises";

import { SYNTHETIC_PASSPHRASE } from "../../../../scripts/lib/synthetic-session.mjs";

const POLL_MS = 100;
const TIMEOUT_MS = 10_000;
const SHARE_ID = "e2e-share-0001";

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

async function typeInto(ctx, id, text) {
  await ctx.evaluate(
    `(() => { const el = document.querySelector('${ctx.testId(id)}'); el.focus(); el.select(); })()`
  );
  await ctx.client.send("Input.insertText", { text });
}

/** Runs `source` in every new document of this page until the returned remover is called. */
async function onNewDocument(ctx, source) {
  const { identifier } = await ctx.client.send("Page.addScriptToEvaluateOnNewDocument", { source });
  return () => ctx.client.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
}

async function navigateWithShare(ctx, reference) {
  await ctx.client.send("Page.navigate", {
    url: `${ctx.origin}/?lang=en&share=${encodeURIComponent(reference)}`
  });
}

/** The upload waits for the privacy review, sends the summary header and shows the link. */
async function uploadAfterReview(ctx) {
  await ctx.openSynthetic();
  await ctx.evaluate(`(() => {
    window.__shareUploads = [];
    window.XMLHttpRequest = class {
      constructor() { this.headers = {}; this.listeners = {}; this.upload = { addEventListener() {} }; this.status = 200; }
      open(method, url) { this.url = url; }
      setRequestHeader(name, value) { this.headers[name] = value; }
      addEventListener(type, listener) { this.listeners[type] = listener; }
      send(body) {
        window.__shareUploads.push({ url: this.url, headers: this.headers, size: body.byteLength });
        this.responseText = JSON.stringify({ shareId: "${SHARE_ID}" });
        setTimeout(() => this.listeners.load(), 30);
      }
    };
  })()`);
  await ctx.click("share-button");
  await ctx.waitForSelector(ctx.testId("share-upload-item"), "The Share menu did not open");
  await ctx.click("share-upload-item");
  await ctx.waitForSelector(ctx.testId("share-preflight"), "The privacy preflight is missing");
  const disabled = await ctx.evaluate(
    `document.querySelector('${ctx.testId("share-upload-submit")}').disabled`
  );
  ctx.assert(disabled, "Upload is possible before the privacy review");

  await typeInto(ctx, "share-server-url", "http://127.0.0.1:9");
  await ctx.click("share-reviewed");
  await ctx.click("share-upload-submit");
  const shareUrl = await waitForValue(
    ctx,
    `document.querySelector('${ctx.testId("share-url")}')?.value`,
    "The share link did not show"
  );
  ctx.assert(shareUrl === `http://127.0.0.1:9/share/${SHARE_ID}`, "Unexpected share link", {
    shareUrl
  });
  const upload = await ctx.evaluate(`window.__shareUploads[0]`);
  ctx.assert(
    upload.url === "http://127.0.0.1:9/api/share/upload" &&
      typeof upload.headers["x-webblackbox-share-summary"] === "string" &&
      upload.size > 0,
    "The upload did not send the archive with its summary header",
    upload
  );
  await ctx.press("Escape", { code: "Escape", keyCode: 27 });
  return { shareUrl, bytes: upload.size };
}

/** A ?share= id on the saved/default server loads at once (encrypted: the passphrase asks). */
async function openTrustedShareLink(ctx) {
  const archive = (await readFile(ctx.archivePath)).toString("base64");
  const remove = await onNewDocument(
    ctx,
    `(() => {
      const bytes = Uint8Array.from(atob("${archive}"), (char) => char.charCodeAt(0));
      const original = window.fetch.bind(window);
      window.__shareFetches = [];
      window.fetch = (input, init) => {
        const url = String(input);
        if (url.includes("/api/share/${SHARE_ID}/archive")) {
          window.__shareFetches.push(url);
          return Promise.resolve(new Response(bytes, { status: 200 }));
        }
        return original(input, init);
      };
    })()`
  );

  try {
    await navigateWithShare(ctx, SHARE_ID);
    await ctx.waitForSelector(
      ctx.testId("passphrase-dialog"),
      "The shared encrypted archive did not ask for its passphrase"
    );
    await ctx.evaluate(`document.querySelector('${ctx.testId("passphrase-input")}').focus()`);
    await ctx.client.send("Input.insertText", { text: SYNTHETIC_PASSPHRASE });
    await ctx.click("passphrase-submit");
    await ctx.waitForSelector(ctx.testId("stage"), "The shared archive did not load");
    const fileName = await waitForValue(
      ctx,
      `document.querySelector('${ctx.testId("session")}')?.textContent.includes("shared-${SHARE_ID}") && document.querySelector('${ctx.testId("session")}').textContent`,
      "The shared archive is not the open one"
    );
    const fetches = await ctx.evaluate(`window.__shareFetches.length`);
    return { fetches, fileName: fileName.slice(0, 120) };
  } finally {
    await remove();
  }
}

/** A ?share= link to an unknown server only asks; it loads nothing by itself. */
async function untrustedShareLinkAsks(ctx) {
  await navigateWithShare(ctx, "https://evil.example.net/share/abcdefgh1");
  await ctx.waitForSelector(
    ctx.testId("share-untrusted"),
    "The untrusted share server was not shown"
  );
  const origin = await ctx.evaluate(
    `document.querySelector('${ctx.testId("share-untrusted")}').textContent`
  );
  const saved = await ctx.evaluate(`localStorage.getItem("webblackbox.player.shareServerBaseUrl")`);
  ctx.assert(saved === null || !saved.includes("evil"), "The link changed the saved share server", {
    saved
  });
  await ctx.press("Escape", { code: "Escape", keyCode: 27 });
  return { origin };
}

export default {
  feature: "share",
  scenarios: [
    { name: "upload after the privacy review", run: uploadAfterReview },
    { name: "open a trusted ?share= link", run: openTrustedShareLink },
    { name: "an untrusted ?share= link asks first", run: untrustedShareLinkAsks }
  ]
};
