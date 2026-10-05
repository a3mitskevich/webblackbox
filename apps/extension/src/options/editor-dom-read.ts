import { CAPTURE_CATEGORY_KEYS } from "../shared/profiles/categories.js";
import type {
  ProfileRule,
  RecordingProfile,
  RecordingProfilesStore
} from "../shared/profiles/model.js";
import { readCheckbox, readField } from "./dom.js";
import { applyProfileFormValues, ruleFromFormValues } from "./profile-form-model.js";

/** Reads the profiles editor's inputs back into draft values, exactly as typed in the page. */

/** `profile` with the values of its open form applied. */
export function readProfileForm(form: HTMLElement, profile: RecordingProfile): RecordingProfile {
  return applyProfileFormValues(profile, {
    name: readField(form, "name"),
    base: readField(form, "base"),
    categories: Object.fromEntries(
      CAPTURE_CATEGORY_KEYS.map((key) => [key, readField(form, `category-${key}`)])
    ),
    contentRedaction: readCheckbox(form, "contentRedaction"),
    builtInHeuristics: readCheckbox(form, "builtInHeuristics"),
    blockedSelectors: readField(form, "blockedSelectors"),
    unmaskSelectors: readField(form, "unmaskSelectors"),
    redactHeaders: readField(form, "redactHeaders"),
    redactCookieNames: readField(form, "redactCookieNames"),
    redactBodyPatterns: readField(form, "redactBodyPatterns"),
    redactQueryParams: readField(form, "redactQueryParams"),
    redactStorageKeys: readField(form, "redactStorageKeys"),
    valuePatterns: readField(form, "valuePatterns"),
    bodyMimeAllowlist: readField(form, "bodyMimeAllowlist"),
    bodyMaxBytes: readField(form, "bodyMaxBytes"),
    includeUrls: readField(form, "includeUrls"),
    excludeUrls: readField(form, "excludeUrls"),
    mousemoveHz: readField(form, "mousemoveHz"),
    visual: readField(form, "visual")
  });
}

/** Rule rows and the extended host list; `fallbackHosts` while the host field is not rendered. */
export function readRulesFromDom(
  root: ParentNode,
  fallbackHosts: string[]
): Pick<RecordingProfilesStore, "rules" | "extendedCaptureHosts"> {
  const rules: ProfileRule[] = [
    ...root.querySelectorAll<HTMLElement>(".wb-profiles__rule")
  ].flatMap((row) => {
    const id = row.dataset.ruleId;

    return id
      ? [
          ruleFromFormValues({
            id,
            name: readField(row, "ruleName"),
            profileId: readField(row, "ruleProfile"),
            priority: readField(row, "rulePriority"),
            enabled: readCheckbox(row, "ruleEnabled"),
            hosts: readField(row, "ruleHosts"),
            paths: readField(row, "rulePaths"),
            query: readField(row, "ruleQuery"),
            titleRegex: readField(row, "ruleTitleRegex"),
            selectorPresent: readField(row, "ruleSelector"),
            metaName: readField(row, "ruleMetaName"),
            metaValue: readField(row, "ruleMetaValue"),
            incognito: readField(row, "ruleIncognito")
          })
        ]
      : [];
  });
  const hostsField = root.querySelector<HTMLInputElement>('[name="extendedCaptureHosts"]');

  return {
    rules,
    extendedCaptureHosts: hostsField
      ? hostsField.value
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      : fallbackHosts
  };
}
