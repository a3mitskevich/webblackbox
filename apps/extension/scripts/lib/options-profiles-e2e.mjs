// Profile deletion and restore in real Chrome (backlog item 4): every delete asks and names the
// site rules that use the profile, the last profile cannot be deleted, rules to a deleted profile
// are flagged and kept, "Restore recommended profiles" brings the presets back, an open profile
// form survives deleting another profile, the unsaved-changes guard covers deletions, and the
// popup's "no profile" panel links to the profiles section of Options.

import {
  click,
  exists,
  isTrue,
  q,
  savebarDirty,
  shownSection,
  typeText,
  unloadPrompts,
  waitUntil
} from "./options-guard-e2e.mjs";

const PROFILES_KEY = "webblackbox.profiles";
const DIALOG = "[role='dialog']";
const WAIT_MS = 4_000;
const NO_DIALOG_WAIT_MS = 1_000;
const RECOMMENDED_IDS = [
  "default",
  "builtin:lite",
  "builtin:full",
  "builtin:qa",
  "builtin:full-capture"
];
const LAST_ID = "builtin:full-capture";
const SEEDED_STORE = {
  schemaVersion: 2,
  defaultProfileId: "default",
  profiles: [],
  rules: [
    {
      id: "rule-checkout",
      name: "Checkout",
      profileId: "default",
      priority: 2,
      enabled: true,
      match: { hosts: ["shop.example.com"] }
    },
    {
      id: "rule-stage",
      name: "Stage",
      profileId: "builtin:qa",
      priority: 1,
      enabled: true,
      match: { hosts: ["*.stage.example.com"] }
    }
  ],
  extendedCaptureHosts: []
};
const NO_PROFILE_PREVIEW = { kind: "sw.profile-preview", catalog: [], selection: null };

/**
 * @param {{
 *   browser: any,
 *   extensionId: string,
 *   openPage: (browser: any, width: number, height: number, fixture: any) => Promise<any>,
 *   navigate: (page: any, url: string) => Promise<void>,
 *   waitForEvent: (page: any, method: string, timeoutMs: number) => Promise<any>,
 *   sleep: (ms: number) => Promise<void>,
 *   capture: (page: any, name: string) => Promise<void>
 * }} deps
 * @returns {Promise<string[]>} failures
 */
export async function runOptionsProfilesChecks(deps) {
  const failures = [];
  const check = (ok, message) => {
    if (!ok) {
      failures.push(`options-profiles: ${message}`);
    }
  };
  const page = await deps.openPage(deps.browser, 1440, 900, null);
  const optionsUrl = `chrome-extension://${deps.extensionId}/options.html`;

  try {
    await seedProfiles(deps, page, optionsUrl, SEEDED_STORE);
    await checkDeleteDownToOne(deps, page, check);
    await checkOrphanedRulesAndRestore(deps, page, check);
    await checkOpenFormSurvivesDelete(deps, page, check);
    const deepLink = await popupDeepLink(deps, check);
    await checkEmptyState(deps, page, optionsUrl, deepLink, check);
  } catch (error) {
    failures.push(`options-profiles: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await page.close();
  }

  return failures;
}

/** Writes the profiles store and reloads the page on it (the page must have nothing unsaved). */
async function seedProfiles(deps, page, optionsUrl, store) {
  await deps.navigate(page, `${optionsUrl}#profiles`);
  await page.evaluate(
    `chrome.storage.local.set({ ${JSON.stringify(PROFILES_KEY)}: ${JSON.stringify(store)} }).then(() => true)`
  );
  await deps.navigate(page, "about:blank");
  await deps.navigate(page, `${optionsUrl}#profiles`);
}

async function checkDeleteDownToOne(deps, page, check) {
  check((await profileIds(page)).length === 5, "the seeded store does not list 5 profiles");
  check(await isTrue(page, restoreDisabled()), "Restore is enabled with nothing deleted");

  await click(page, deleteOf("default"));
  check(await waitUntil(page, exists(DIALOG), WAIT_MS), "deleting Default: no prompt");
  const items = await page.evaluate(
    `[...document.querySelectorAll("[data-confirm-item]")].map((item) => item.textContent)`
  );
  check(
    JSON.stringify(items) === JSON.stringify(["Checkout"]),
    `the delete prompt does not name the rule that uses Default (${JSON.stringify(items)})`
  );
  await deps.capture(page, "options-1440-profile-delete-prompt");
  await acceptDelete(page, "default", check);

  check(await isTrue(page, savebarDirty()), "a deleted profile did not mark the page unsaved");
  check(
    await isTrue(page, `${q("[data-section-link='profiles']")}?.dataset.dirty === "true"`),
    "a deleted profile did not mark the Profiles nav link"
  );
  check(
    await isTrue(page, exists("[data-rule-id='rule-checkout'].wb-rule--orphan")),
    "the rule to the deleted Default is not flagged"
  );
  check(await unloadPrompts(deps, page), "unsaved delete → navigate away: no beforeunload prompt");

  for (const id of ["builtin:lite", "builtin:full", "builtin:qa"]) {
    await click(page, deleteOf(id));
    check(await waitUntil(page, exists(DIALOG), WAIT_MS), `deleting ${id}: no prompt`);
    await acceptDelete(page, id, check);
  }

  check(
    JSON.stringify(await profileIds(page)) === JSON.stringify([LAST_ID]),
    "deleting four profiles did not leave Full capture alone"
  );
  check(
    await isTrue(page, `${q(deleteOf(LAST_ID))}?.disabled === true`),
    "Delete of the last profile is not disabled"
  );
  check(
    await isTrue(page, `${q("[data-profiles-last]")}?.offsetParent !== null`),
    "no visible explanation why the last profile cannot be deleted"
  );
  await click(page, deleteOf(LAST_ID));
  await deps.sleep(NO_DIALOG_WAIT_MS);
  check(!(await isTrue(page, exists(DIALOG))), "the disabled Delete of the last profile prompted");
  await deps.capture(page, "options-1440-profiles-last");
}

async function checkOrphanedRulesAndRestore(deps, page, check) {
  // Leaving the section with unsaved deletions asks; Save stores them.
  await click(page, "[data-section-link='rules']");
  check(await waitUntil(page, exists(DIALOG), WAIT_MS), "unsaved deletions → nav: no leave prompt");
  await click(page, "[data-action='leave-save']");
  check(
    await waitUntil(page, shownSection("rules"), WAIT_MS),
    "Save in the leave prompt did not switch the section"
  );

  const saved = await readStore(page);
  check(
    JSON.stringify(saved?.removedRecommendedProfileIds) ===
      JSON.stringify(RECOMMENDED_IDS.filter((id) => id !== LAST_ID)) &&
      saved?.defaultProfileId === LAST_ID &&
      saved?.rules?.length === 2,
    `saved deletions are wrong (${JSON.stringify(saved)})`
  );
  check(
    await isTrue(page, `${q("[data-rules-orphaned]")}?.textContent.startsWith("2 ")`),
    "the rules list does not count the 2 rules to deleted profiles"
  );
  await deps.capture(page, "options-1440-rules-orphaned");

  await click(page, "[data-rules-orphaned] [data-action='profiles-restore']");
  check(
    await waitUntil(page, `!${exists(".wb-rule--orphan")}`, WAIT_MS),
    "Restore in a rule notice left rules flagged"
  );
  await click(page, "[data-action='settings-save']");
  check(
    await waitUntil(page, `!(${savebarDirty()})`, WAIT_MS),
    "Save after Restore left the bar dirty"
  );
  const restored = await readStore(page);
  check(
    restored !== undefined && restored.removedRecommendedProfileIds === undefined,
    `Restore was not saved (${JSON.stringify(restored)})`
  );

  await click(page, "[data-section-link='profiles']");
  check(await waitUntil(page, shownSection("profiles"), WAIT_MS), "saved → nav: no section switch");
  check(
    JSON.stringify(await profileIds(page)) === JSON.stringify(RECOMMENDED_IDS),
    "Restore did not bring back the recommended profiles"
  );
  check(await isTrue(page, restoreDisabled()), "Restore stays enabled after restoring");
}

/** Item 1's guard keeps working: deleting another profile keeps the open form and its edits. */
async function checkOpenFormSurvivesDelete(deps, page, check) {
  // A deleted preset that is not the default changes only the deleted-preset list.
  await click(page, deleteOf("builtin:qa"));
  check(await waitUntil(page, exists(DIALOG), WAIT_MS), "deleting QA: no prompt");
  await acceptDelete(page, "builtin:qa", check);
  check(
    await isTrue(page, `${q("[data-section-link='profiles']")}?.dataset.dirty === "true"`),
    "deleting a preset that is not the default did not mark the Profiles nav link"
  );
  await click(page, "[data-action='settings-cancel']");
  check(await waitUntil(page, `!(${savebarDirty()})`, WAIT_MS), "Discard left the page unsaved");

  await click(page, "[data-profile-id='builtin:lite'] [data-action='profile-duplicate']");
  check(await waitUntil(page, exists("[data-profile-form]"), WAIT_MS), "Duplicate opened no form");
  await typeText(page, "#pf-name", "Lite copy edited");

  await click(page, deleteOf("builtin:full"));
  check(await waitUntil(page, exists(DIALOG), WAIT_MS), "deleting Full: no prompt");
  await acceptDelete(page, "builtin:full", check);
  check(
    await isTrue(page, `${q("#pf-name")}?.value === "Lite copy edited"`),
    "deleting another profile closed the open form or lost its edits"
  );

  await click(page, "[data-action='settings-cancel']");
  check(await waitUntil(page, `!(${savebarDirty()})`, WAIT_MS), "Discard left the page unsaved");
  check(
    JSON.stringify(await profileIds(page)) === JSON.stringify(RECOMMENDED_IDS),
    "Discard did not bring back the deleted profile"
  );
}

/** The popup with no profile: its panel opens Options at the profiles section. */
async function popupDeepLink(deps, check) {
  const popup = await deps.openPage(deps.browser, 360, 600, {
    preview: NO_PROFILE_PREVIEW,
    port: "webblackbox:popup"
  });

  try {
    await deps.navigate(popup, `chrome-extension://${deps.extensionId}/popup.html`);
    check(
      await waitUntil(popup, exists("[data-profile-required]"), WAIT_MS),
      "the popup shows no 'no profile' panel"
    );
    check(!(await isTrue(popup, exists("[data-action='start']"))), "the popup still offers Start");
    await popup.evaluate(`${q("[data-action='open-profiles']")}?.click(), true`);
    await waitUntil(popup, "(globalThis.__wbCreatedTabs ?? []).length > 0", WAIT_MS);
    const url = await popup.evaluate(`globalThis.__wbCreatedTabs?.[0]?.url ?? ""`);
    check(
      url === `chrome-extension://${deps.extensionId}/options.html#profiles`,
      `Open profiles opened ${JSON.stringify(url)}`
    );
    return url;
  } finally {
    await popup.close();
  }
}

/** No profile left (an older store or an import): Options says so and Restore fixes it. */
async function checkEmptyState(deps, page, optionsUrl, deepLink, check) {
  await seedProfiles(deps, page, optionsUrl, {
    ...SEEDED_STORE,
    removedRecommendedProfileIds: RECOMMENDED_IDS
  });

  if (deepLink) {
    await deps.navigate(page, "about:blank");
    await deps.navigate(page, deepLink);
  }

  check(await isTrue(page, shownSection("profiles")), "the deep link did not open Profiles");
  check(await isTrue(page, exists("[data-profiles-empty]")), "no empty-state notice");
  await deps.capture(page, "options-1440-profiles-empty");

  await click(page, "[data-profiles-empty] [data-action='profiles-restore']");
  check(
    await waitUntil(page, `document.querySelectorAll("[data-profile-id]").length === 5`, WAIT_MS),
    "Restore in the empty state did not bring the profiles back"
  );
  await click(page, "[data-action='settings-save']");
  check(
    await waitUntil(page, `!(${savebarDirty()})`, WAIT_MS),
    "Save after Restore left the bar dirty"
  );
}

async function acceptDelete(page, profileId, check) {
  await click(page, "[data-confirm-accept]");
  check(
    await waitUntil(page, `!${exists(`[data-profile-id='${profileId}']`)}`, WAIT_MS),
    `${profileId} is still listed after Delete`
  );
}

function deleteOf(profileId) {
  return `[data-profile-id='${profileId}'] [data-action='profile-delete']`;
}

function restoreDisabled() {
  return `${q(".wb-profiles__list-actions [data-action='profiles-restore']")}?.disabled === true`;
}

function profileIds(page) {
  return page.evaluate(
    `[...document.querySelectorAll("[data-profile-id]")].map((row) => row.dataset.profileId)`
  );
}

function readStore(page) {
  return page.evaluate(
    `chrome.storage.local.get(${JSON.stringify(PROFILES_KEY)}).then((values) => values[${JSON.stringify(PROFILES_KEY)}])`
  );
}
