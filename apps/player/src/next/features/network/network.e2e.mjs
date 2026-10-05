// e2e:player-next scenarios of the network feature (picked up by scripts/e2e-player-next.mjs).
// Tester flows through data-testid hooks only; archive data correctness lives in player-sdk tests.

const text = (ctx, selector) =>
  ctx.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);

/** Waits until `selector` exists and its text contains `needle`; returns the text. */
async function waitForText(ctx, selector, needle, message) {
  const deadline = Date.now() + 8_000;

  while (Date.now() < deadline) {
    const value = await text(ctx, selector);

    if (value.includes(needle)) {
      return value;
    }

    await ctx.sleep(100);
  }

  throw new Error(`${message}: "${needle}" not in ${selector} (${await text(ctx, selector)})`);
}

const exists = (ctx, selector) =>
  ctx.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);

async function openNetwork(ctx) {
  await ctx.openSynthetic({ hash: "#tab=network" });
  await ctx.waitForSelector(ctx.testId("network-table"), "The Network table did not render");
}

/** Types into the Network filter (the player-wide query), replacing what is there. */
async function filter(ctx, value) {
  await ctx.evaluate(`(() => {
    const input = document.querySelector('${ctx.testId("network-filter")}');
    input.focus();
    input.select();
  })()`);

  if (value) {
    await ctx.client.send("Input.insertText", { text: value });
  } else {
    await ctx.press("Delete", { code: "Delete", keyCode: 46 });
  }

  await ctx.sleep(150);
}

/** Filters to one request and opens its details; focus leaves the field (keys work again). */
async function openRequest(ctx, value) {
  await filter(ctx, value);
  await ctx.waitForSelector(ctx.testId("request-row"), `No row matches "${value}"`);
  await ctx.click("request-row");
  await ctx.evaluate("document.activeElement?.blur()");
}

async function selectRequestBody(ctx) {
  await openNetwork(ctx);
  await openRequest(ctx, "casino-user");
  await ctx.waitForSelector(ctx.testId("request-details"), "Selecting a row opened no details");
  await ctx.click("detail-tab-response");
  const body = await waitForText(
    ctx,
    ctx.testId("response-body-tree"),
    "invalid_token",
    "The 401 body did not show as a JSON tree"
  );
  await ctx.click("body-view-raw");
  await ctx.waitForSelector(
    `${ctx.testId("response-body-raw")}[data-highlighted="true"]`,
    "The raw body was not highlighted (Shiki chunk)"
  );
  await ctx.sleep(500);
  const hash = await ctx.evaluate("decodeURIComponent(location.hash)");
  ctx.assert(hash.includes("sel=req:"), "The selection is not in the URL hash", hash);
  return { body: body.slice(0, 60), hash };
}

async function notCapturedReasons(ctx) {
  await openNetwork(ctx);
  const chip = await text(ctx, ctx.testId("net-not-captured"));
  ctx.assert(/[1-9]/.test(chip), "Not captured chip has no count", chip);

  await openRequest(ctx, "export.csv");
  ctx.assert(await exists(ctx, ctx.testId("row-not-captured")), "No table marker for the skip");
  await ctx.click("detail-tab-response");
  const reason = await waitForText(
    ctx,
    ctx.testId("response-body-note"),
    "too large (5.00 MB, limit 1.00 MB)",
    "The too-large reason is missing"
  );

  await openRequest(ctx, "lobby/api");
  ctx.assert(await exists(ctx, ctx.testId("row-cut")), "The cut body has no table badge");
  await ctx.click("detail-tab-response");
  const cut = await waitForText(ctx, ctx.testId("response-body-cut"), "Cut at", "No cut badge");

  await openRequest(ctx, "telemetry");
  await ctx.click("detail-tab-payload");
  const requestReason = await waitForText(
    ctx,
    ctx.testId("request-body-note"),
    "does not expose",
    "The request body reason is missing"
  );

  // The "Not captured" filter keeps only the incomplete rows (sockets with cut frames included).
  await filter(ctx, "");
  await ctx.click("net-not-captured");
  await ctx.sleep(150);
  const kinds = await ctx.evaluate(
    `[...document.querySelectorAll('${ctx.testId("request-row")}')].map((row) => row.dataset.rowId)`
  );
  ctx.assert(
    ["90080.1400", "90080.1410", "90080.1420"].every((id) => kinds.includes(id)) &&
      !kinds.includes("90080.1706"),
    "The Not captured filter shows other rows",
    kinds
  );
  await ctx.click("net-not-captured");
  return { chip, reason, cut, requestReason, rows: kinds.length };
}

async function formPayload(ctx) {
  await openNetwork(ctx);
  await openRequest(ctx, "preferences");
  await ctx.click("detail-tab-payload");
  const form = await waitForText(ctx, ctx.testId("form-data"), "two words", "Form fields missing");
  const query = await text(ctx, ctx.testId("query-params"));
  ctx.assert(query.includes("lang"), "The query string is missing", query);
  return { form };
}

async function socketFrame(ctx) {
  await openNetwork(ctx);
  await ctx.click("net-type-ws");
  await ctx.sleep(150);
  const sockets = await ctx.evaluate(
    `document.querySelectorAll('${ctx.testId("request-row")}[data-kind="socket"]').length`
  );
  ctx.assert(sockets === 2, "The WS chip did not keep the two sockets", { sockets });
  await openRequest(ctx, "proxy-live");
  await ctx.waitForSelector(ctx.testId("socket-details"), "No socket details");
  const hidden = await text(ctx, ctx.testId("hidden-params"));
  ctx.assert(hidden.includes("access_token"), "The token is not marked hidden", hidden);
  const url = await text(ctx, ctx.testId("details-url"));
  ctx.assert(!url.includes("eyJ"), "The socket URL shows the token", url);
  await ctx.click("detail-tab-messages");
  await ctx.waitForSelector(ctx.testId("message-row"), "No messages");
  await ctx.evaluate(`[...document.querySelectorAll('${ctx.testId("message-row")}')]
    .find((row) => row.textContent.includes("GameState") && row.textContent.includes("cut"))
    .click()`);
  const cut = await waitForText(ctx, ctx.testId("message-cut"), "recorded", "No cut notice");
  const rest = await text(ctx, ctx.testId("message-rest"));
  ctx.assert(rest.includes("not captured"), "The cut frame does not say what is missing", rest);
  await ctx.click("net-type-all");
  return { cut, rest };
}

async function serverSentEvents(ctx) {
  await openNetwork(ctx);
  await openRequest(ctx, "feed/api");
  const tab = await waitForText(ctx, ctx.testId("detail-tab-messages"), "3", "SSE messages tab");
  await ctx.click("detail-tab-messages");
  await ctx.waitForSelector(ctx.testId("message-row"), "SSE messages are not listed");
  return { tab };
}

async function realtimeConversation(ctx) {
  await openNetwork(ctx);
  await ctx.press("4", { code: "Digit4" });
  await ctx.waitForSelector(ctx.testId("conversation"), "The Realtime tab shows no conversation");
  // Pick the SignalR socket (the first connection of the fixture is an SSE stream).
  await ctx.evaluate(`(() => {
    const select = document.querySelector('${ctx.testId("stream-select")}');
    const option = [...select.options].find((item) => item.textContent.includes("proxy-live"));
    const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setValue.call(select, option.value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await ctx.sleep(200);
  const directions = await ctx.evaluate(`[...new Set([...document.querySelectorAll(
    '${ctx.testId("conversation-message")}')].map((item) => item.dataset.direction))].sort()`);
  ctx.assert(
    JSON.stringify(directions) === '["received","sent"]',
    "The conversation does not show both directions",
    directions
  );
  await ctx.click("conversation-message");
  await ctx.waitForSelector(ctx.testId("message-view"), "Selecting a message opened nothing");
  return { directions };
}

async function fullWidthRail(ctx) {
  await openNetwork(ctx);
  const stageWidth = () =>
    ctx.evaluate(`document.querySelector('.stage-col').getBoundingClientRect().width`);
  const before = await stageWidth();
  await ctx.evaluate("document.activeElement?.blur()");
  await ctx.press("f");
  await ctx.sleep(200);
  const wide = await stageWidth();
  const railWidth = await ctx.evaluate(
    `document.querySelector('${ctx.testId("rail")}').getBoundingClientRect().width`
  );
  ctx.assert(wide < 2 && railWidth > 1_400, "F did not give the rail the whole width", {
    wide,
    railWidth
  });
  await ctx.click("rail-wide");
  await ctx.sleep(200);
  const back = await stageWidth();
  ctx.assert(Math.abs(back - before) < 2, "The stage did not come back at its width", {
    before,
    back
  });
  return { before, wide, back };
}

async function localeKeepsSelection(ctx) {
  await openNetwork(ctx);
  await openRequest(ctx, "casino-user");
  await ctx.click("detail-tab-timing");
  await ctx.waitForSelector(ctx.testId("timing-phase"), "No timing phases");
  await ctx.click("locale-ru");
  const tab = await waitForText(ctx, ctx.testId("detail-tab-timing"), "Тайминг", "No RU labels");
  const stillOpen = await exists(ctx, ctx.testId("request-details"));
  const unloads = await ctx.evaluate("window.__unloads ?? 0");
  await ctx.click("locale-en");
  ctx.assert(stillOpen && unloads === 0, "The language switch lost the request or reloaded", {
    stillOpen,
    unloads
  });
  return { tab };
}

async function copyCurl(ctx) {
  await openNetwork(ctx);
  await ctx.client.send("Browser.grantPermissions", {
    origin: ctx.origin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"]
  });
  await openRequest(ctx, "casino-user");
  await ctx.click("copy-curl");
  const status = await waitForText(ctx, ctx.testId("copy-curl-status"), "Copied", "Not copied");
  const clipboard = await ctx.evaluate("navigator.clipboard.readText()");
  ctx.assert(String(clipboard).startsWith("curl "), "The clipboard has no curl command", clipboard);
  return { status };
}

export default {
  feature: "network",
  scenarios: [
    { name: "select a request and read its JSON body", run: selectRequestBody },
    { name: "not captured reasons, cut badge and filter", run: notCapturedReasons },
    { name: "form payload and query string", run: formPayload },
    { name: "open a WebSocket frame cut by the recorder", run: socketFrame },
    { name: "SSE messages on their request", run: serverSentEvents },
    { name: "Realtime conversation", run: realtimeConversation },
    { name: "F gives the rail the whole width", run: fullWidthRail },
    { name: "switch the language without losing the request", run: localeKeepsSelection },
    { name: "copy as curl", run: copyCurl }
  ]
};
