import type { ExtensionMessageKey } from "../shared/i18n.js";
import type { RecordingProfile } from "../shared/profiles/model.js";
import { previewRedaction, type RedactionSandboxKind } from "../shared/redaction-sandbox.js";
import { readField } from "./dom.js";
import { SANDBOX_KINDS } from "./profiles-view.js";

/** State of the redaction sandbox: what is typed and the last preview. */

type Translate = (key: ExtensionMessageKey, vars?: Record<string, string | number>) => string;

export type SandboxState = {
  profileId: string;
  kind: RedactionSandboxKind;
  text: string;
  output?: string;
};

/** What the sandbox controls hold now; `current` when the panel is not rendered. */
export function readSandboxInputs(root: HTMLElement, current: SandboxState): SandboxState {
  const input = root.querySelector<HTMLTextAreaElement>("[name='sandboxInput']");

  if (!input) {
    return current;
  }

  const kind = SANDBOX_KINDS.find((entry) => entry.value === readField(root, "sandboxKind"));

  return {
    ...current,
    profileId: readField(root, "sandboxProfile") || current.profileId,
    kind: kind?.value ?? current.kind,
    text: input.value
  };
}

/** Runs the chosen profile's redaction over the typed sample. */
export function runRedactionSandbox(
  sandbox: SandboxState,
  catalog: readonly RecordingProfile[],
  t: Translate
): SandboxState {
  const inputs: SandboxState = {
    profileId: sandbox.profileId,
    kind: sandbox.kind,
    text: sandbox.text
  };
  const profile = catalog.find((entry) => entry.id === sandbox.profileId);

  if (!profile) {
    return inputs;
  }

  const result = previewRedaction(
    { kind: sandbox.kind, text: sandbox.text },
    { ...profile.redaction, unmaskSelectors: profile.unmaskSelectors }
  );

  return {
    ...inputs,
    output:
      result.error === "invalid-json"
        ? t("optionsSandboxInvalidJson")
        : result.changed
          ? result.output
          : t("optionsSandboxUnchanged")
  };
}
