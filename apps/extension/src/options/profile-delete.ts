import type { ExtensionMessageKey } from "../shared/i18n.js";
import type { RecordingProfile, RecordingProfilesStore } from "../shared/profiles/model.js";
import { isRecommendedProfileId } from "../shared/profiles/presets.js";
import {
  listStoreProfiles,
  removeProfileFromStore,
  restoreRecommendedProfiles
} from "../shared/profiles/storage.js";
import { openConfirmDialog } from "../shared/ui/dialogs.js";
import { sortRulesForDisplay } from "./profile-form-model.js";
import { ruleLabel } from "./rule-tester.js";

/**
 * Deleting profiles and restoring the recommended ones. Recording needs a profile, so the last
 * one cannot be deleted; a delete always asks and says what else changes.
 */

type Translate = (key: ExtensionMessageKey, vars?: Record<string, string | number>) => string;

/** The catalog (own, policy and preset profiles) keeps at least one profile to record with. */
export function canDeleteProfile(catalog: readonly RecordingProfile[]): boolean {
  return catalog.length > 1;
}

/** "Restore recommended profiles" would bring a deleted Default or preset back. */
export function hasRecommendedProfilesToRestore(store: RecordingProfilesStore): boolean {
  return (
    listStoreProfiles(restoreRecommendedProfiles(store)).length > listStoreProfiles(store).length
  );
}

export type ProfileDeletion = {
  name: string;
  /** Labels of the site rules that use the profile, as the rules list orders them. */
  ruleNames: string[];
  /** Default and the presets come back with "Restore recommended profiles". */
  restorable: boolean;
  /** The profile that becomes the default when the deleted one was it. */
  nextDefaultName?: string;
};

export function describeProfileDeletion(
  store: RecordingProfilesStore,
  catalog: readonly RecordingProfile[],
  profileId: string
): ProfileDeletion {
  const nameOf = (id: string) => catalog.find((profile) => profile.id === id)?.name;
  const nextDefaultId = removeProfileFromStore(store, profileId).defaultProfileId;
  const nextDefaultName =
    store.defaultProfileId === profileId && nextDefaultId !== profileId
      ? nameOf(nextDefaultId)
      : undefined;

  return {
    name: nameOf(profileId) ?? profileId,
    ruleNames: sortRulesForDisplay(store.rules)
      .filter((rule) => rule.profileId === profileId)
      .map(ruleLabel),
    restorable: isRecommendedProfileId(profileId),
    ...(nextDefaultName ? { nextDefaultName } : {})
  };
}

/** Delete prompt: the rules that use the profile, whether it can come back, the next default. */
export function confirmProfileDeletion(t: Translate, deletion: ProfileDeletion): Promise<boolean> {
  const count = deletion.ruleNames.length;

  return openConfirmDialog({
    title: t("optionsProfileDeleteTitle", { name: deletion.name }),
    body: count > 0 ? t("optionsProfileDeleteRules", { count }) : t("optionsProfileDeleteNoRules"),
    items: deletion.ruleNames,
    notes: [
      t(deletion.restorable ? "optionsProfileDeleteRestorable" : "optionsProfileDeleteOwn"),
      ...(deletion.nextDefaultName
        ? [t("optionsProfileDeleteNewDefault", { name: deletion.nextDefaultName })]
        : [])
    ],
    acceptLabel: t("optionsProfileDelete"),
    cancelLabel: t("optionsProfileCancel"),
    acceptVariant: "danger"
  });
}
