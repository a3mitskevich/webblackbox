// Unsaved-changes guard of the options page in real Chrome (backlog item 1): leaving a section
// with unsaved changes asks first, closing the tab triggers `beforeunload`, closing a rule or a
// profile editor with edits asks too, and none of it happens once everything is saved.
//
// Clicks and typing go through CDP Input events: Chrome only shows the beforeunload prompt on a
// page the user has interacted with.

const DIALOG = "[role='dialog']";
const PROMPT_WAIT_MS = 4_000;
const NO_PROMPT_WAIT_MS = 1_500;

/**
 * @param {{
 *   browser: { send: (method: string, params?: object, sessionId?: string) => Promise<any> },
 *   extensionId: string,
 *   openPage: (browser: any, width: number, height: number, fixture: any) => Promise<any>,
 *   navigate: (page: any, url: string) => Promise<void>,
 *   waitForEvent: (page: any, method: string, timeoutMs: number) => Promise<any>,
 *   sleep: (ms: number) => Promise<void>
 * }} deps
 * @returns {Promise<string[]>} failures
 */
export async function runOptionsGuardChecks(deps) {
  const failures = [];
  const check = (ok, message) => {
    if (!ok) {
      failures.push(`options-guard: ${message}`);
    }
  };
  const page = await deps.openPage(deps.browser, 1440, 900, null);
  const optionsUrl = `chrome-extension://${deps.extensionId}/options.html`;

  try {
    await checkSectionGuardAndUnload(deps, page, optionsUrl, check);
    await checkRuleCloseGuard(deps, page, optionsUrl, check);
    await checkProfileCloseGuard(deps, page, optionsUrl, check);
  } catch (error) {
    failures.push(`options-guard: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await page.close();
  }

  return failures;
}

async function checkSectionGuardAndUnload(deps, page, optionsUrl, check) {
  await deps.navigate(page, `${optionsUrl}#pointer`);
  await typeText(page, "#scrollHz", "30");

  check(await isTrue(page, savebarDirty()), "editing a field did not mark the save bar dirty");
  check(
    await isTrue(page, `${q("[data-section-link='pointer']")}?.dataset.dirty === "true"`),
    "editing a field did not mark its nav link"
  );

  await click(page, "[data-section-link='sampling']");
  check(await waitUntil(page, exists(DIALOG), PROMPT_WAIT_MS), "dirty → nav: no leave prompt");
  check(await isTrue(page, shownSection("pointer")), "dirty → nav: the section switched anyway");

  await click(page, "[data-action='leave-stay']");
  check(
    await waitUntil(page, `!${exists(DIALOG)}`, PROMPT_WAIT_MS),
    "Stay did not close the prompt"
  );
  check(await isTrue(page, shownSection("pointer")), "Stay left the section");

  check(await unloadPrompts(deps, page), "dirty → navigate away: no beforeunload prompt");
  check(
    await isTrue(page, `location.pathname.endsWith("/options.html")`),
    "a cancelled beforeunload prompt still left the page"
  );

  await click(page, "[data-action='settings-save']");
  check(await waitUntil(page, `!(${savebarDirty()})`, PROMPT_WAIT_MS), "Save left the bar dirty");

  await click(page, "[data-section-link='sampling']");
  await deps.sleep(NO_PROMPT_WAIT_MS / 3);
  check(!(await isTrue(page, exists(DIALOG))), "saved → nav: a leave prompt appeared");
  check(await isTrue(page, shownSection("sampling")), "saved → nav: the section did not switch");

  check(!(await unloadPrompts(deps, page)), "saved → navigate away: beforeunload still prompted");
}

async function checkRuleCloseGuard(deps, page, optionsUrl, check) {
  await deps.navigate(page, `${optionsUrl}#rules`);
  const ruleCount = () => page.evaluate(`document.querySelectorAll("[data-rule-id]").length`);
  const before = await ruleCount();

  await click(page, "[data-action='rule-add']");
  await typeText(page, "[data-rule-id]:last-child [name='ruleName']", "Stage QA");
  check(
    await isTrue(page, `${q("[data-rule-id]:last-child [data-unsaved-badge]")}?.hidden === false`),
    "a new rule shows no Unsaved badge"
  );

  await click(page, "[data-rule-id]:last-child [data-action='rule-toggle']");
  check(await waitUntil(page, exists(DIALOG), PROMPT_WAIT_MS), "collapsing a new rule: no prompt");
  await click(page, "[data-action='editor-close-discard']");
  check(
    await waitUntil(
      page,
      `document.querySelectorAll("[data-rule-id]").length === ${before}`,
      2_000
    ),
    "Discard did not remove the new rule"
  );
  check(!(await isTrue(page, savebarDirty())), "Discard left the page dirty");

  await click(page, "[data-action='rule-add']");
  await typeText(page, "[data-rule-id]:last-child [name='ruleName']", "Stage QA");
  await click(page, "[data-section-link='profiles']");
  check(await waitUntil(page, exists(DIALOG), PROMPT_WAIT_MS), "unsaved rule → nav: no prompt");
  await click(page, "[data-action='leave-save']");
  check(
    await waitUntil(page, shownSection("profiles"), PROMPT_WAIT_MS),
    "Save in the leave prompt did not switch the section"
  );
  const saved = await page.evaluate(`chrome.storage.local
    .get("webblackbox.profiles")
    .then((values) => (values["webblackbox.profiles"]?.rules ?? []).map((rule) => rule.name))`);
  check(
    Array.isArray(saved) && saved.includes("Stage QA"),
    `Save in the leave prompt did not store the rule (${JSON.stringify(saved)})`
  );
}

async function checkProfileCloseGuard(deps, page, optionsUrl, check) {
  await deps.navigate(page, `${optionsUrl}#profiles`);
  await click(page, "[data-profile-id='default'] [data-action='profile-edit']");
  await click(page, "[data-action='profile-apply']");
  await deps.sleep(NO_PROMPT_WAIT_MS / 3);
  check(!(await isTrue(page, exists(DIALOG))), "closing an unedited profile form prompted");

  await click(page, "[data-profile-id='default'] [data-action='profile-edit']");
  await typeText(page, "#pf-name", "Default edited");
  await click(page, "[data-action='profile-apply']");
  check(await waitUntil(page, exists(DIALOG), PROMPT_WAIT_MS), "Apply with edits: no prompt");
  await click(page, "[data-action='editor-close-keep']");
  check(
    await waitUntil(page, exists("[data-profile-form='default']"), 2_000),
    "Keep editing closed the form"
  );

  await click(page, "[data-action='profile-cancel']");
  check(
    await waitUntil(page, exists("[data-confirm-accept]"), PROMPT_WAIT_MS),
    "Cancel: no prompt"
  );
  await click(page, "[data-confirm-accept]");
  check(
    await waitUntil(page, `!${exists("[data-profile-form]")}`, 2_000),
    "discarding from Cancel left the form open"
  );
  check(!(await isTrue(page, savebarDirty())), "discarded profile edits left the page dirty");
}

/** Starts leaving the page; true when Chrome showed the beforeunload prompt (then cancelled). */
async function unloadPrompts(deps, page) {
  const opening = deps.waitForEvent(page, "Page.javascriptDialogOpening", NO_PROMPT_WAIT_MS * 2);
  // Renderer-initiated, as a link or the address bar would be; the prompt blocks it.
  await page.evaluate(`setTimeout(() => { location.href = "about:blank"; }, 0), true`);
  const dialog = await opening;

  if (dialog) {
    await page.send("Page.handleJavaScriptDialog", { accept: false });
    await deps.sleep(300);
    return dialog.type === "beforeunload";
  }

  await deps.sleep(300);
  return false;
}

function q(selector) {
  return `document.querySelector(${JSON.stringify(selector)})`;
}

function exists(selector) {
  return `Boolean(${q(selector)})`;
}

function savebarDirty() {
  return `${q(".wb-savebar")}?.dataset.dirty === "true"`;
}

function shownSection(section) {
  return `${q(`[data-options-section='${section}']`)}?.hidden === false`;
}

async function isTrue(page, expression) {
  return (
    (await page.evaluate(
      `(() => { try { return Boolean(${expression}); } catch { return false; } })()`
    )) === true
  );
}

async function waitUntil(page, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isTrue(page, expression)) {
      return true;
    }

    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }

  return false;
}

/** A real mouse click at the element's centre (gives the page user activation). */
async function click(page, selector) {
  const point = await page.evaluate(`(() => {
    const element = ${q(selector)};

    if (!element) {
      return null;
    }

    element.scrollIntoView({ block: "center" });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);

  if (!point) {
    throw new Error(`${selector} not found`);
  }

  for (const type of ["mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1
    });
  }

  await new Promise((resolveWait) => setTimeout(resolveWait, 150));
}

/** Focuses the field with a click, selects its text and types over it. */
async function typeText(page, selector, text) {
  await click(page, selector);
  await page.evaluate(`${q(selector)}?.select?.()`);
  await page.send("Input.insertText", { text });
  await new Promise((resolveWait) => setTimeout(resolveWait, 150));
}
