import type { ChromeApi } from "../shared/chrome-api.js";
import {
  normalizeEnterprisePolicy,
  readManagedEnterprisePolicy
} from "../shared/options-storage.js";
import { PROFILES_STORAGE_KEY, type RecordingProfilesStore } from "../shared/profiles/model.js";
import {
  parseManagedProfilesPolicy,
  resolveProfilesState,
  type ProfilesState
} from "../shared/profiles/storage.js";
import { createProfilesExportFile } from "../shared/profiles/transfer.js";
import { el } from "./dom.js";

/** Storage reads and the export download of the profiles editor. */

export type EditorStorageDeps = {
  chromeApi: ChromeApi | null;
  legacyOptionsKey: string;
  enterprisePolicyKey: string;
};

/** Managed-policy hosts where extended profiles may run (Test URL applies them too). */
export async function loadEnterpriseSiteAllowlist(deps: EditorStorageDeps): Promise<string[]> {
  const managedPolicy = await readManagedEnterprisePolicy(
    deps.chromeApi?.storage?.managed,
    deps.enterprisePolicyKey
  );

  return normalizeEnterprisePolicy(managedPolicy).siteAllowlist;
}

export async function loadProfilesState(deps: EditorStorageDeps): Promise<ProfilesState> {
  const local = await deps.chromeApi?.storage?.local
    ?.get([PROFILES_STORAGE_KEY, deps.legacyOptionsKey])
    .catch(() => undefined);
  const managedPolicy = await readManagedEnterprisePolicy(
    deps.chromeApi?.storage?.managed,
    deps.enterprisePolicyKey
  );

  return resolveProfilesState({
    rawProfilesStore: local?.[PROFILES_STORAGE_KEY],
    rawLegacyOptions: local?.[deps.legacyOptionsKey],
    managed: parseManagedProfilesPolicy(managedPolicy)
  });
}

export function downloadProfilesExport(store: RecordingProfilesStore): void {
  const blob = new Blob([JSON.stringify(createProfilesExportFile(store), null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const anchor = el("a", { attrs: { href: url, download: "webblackbox-profiles.json" } });

  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
