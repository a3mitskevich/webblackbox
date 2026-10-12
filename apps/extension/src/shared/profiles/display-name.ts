import type { ExtensionMessageKey } from "../i18n.js";
import { BUILT_IN_PROFILE_IDS } from "./presets.js";

/** Built-in profiles keep an English name in storage and archives; the UI shows it translated. */
const BUILT_IN_NAME_KEYS: Readonly<Record<string, ExtensionMessageKey>> = {
  [BUILT_IN_PROFILE_IDS.maximum]: "profileNameMaximum",
  [BUILT_IN_PROFILE_IDS.lite]: "profileNameLight"
};

/** A profile's name as the UI shows it: built-ins in the UI language, others as named. */
export function displayProfileName(
  profile: { id?: string; name: string },
  t: (key: ExtensionMessageKey) => string
): string {
  const key = profile.id ? BUILT_IN_NAME_KEYS[profile.id] : undefined;
  return key ? t(key) : profile.name;
}
