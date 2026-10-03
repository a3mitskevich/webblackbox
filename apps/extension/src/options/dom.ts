/** Small DOM helpers for the options editors (no innerHTML: every value is user data). */

import { el } from "../shared/ui/dom.js";
import { icon, type IconName } from "../shared/ui/icons.js";

export { el };

export type ButtonVariant = "brand" | "muted" | "surface" | "accent" | "ghost" | "danger";

export function button(
  text: string,
  action: string,
  variant: ButtonVariant = "surface",
  options: { small?: boolean; iconName?: IconName } = {}
): HTMLButtonElement {
  return el(
    "button",
    {
      className: `wb-btn wb-btn--${variant}${options.small ? " wb-btn--small" : ""}`,
      attrs: { type: "button" },
      dataset: { action }
    },
    [...(options.iconName ? [icon(options.iconName)] : []), text]
  );
}

export function iconButton(
  label: string,
  action: string,
  name: IconName,
  options: { danger?: boolean; disabled?: boolean } = {}
): HTMLButtonElement {
  const element = el(
    "button",
    {
      className: options.danger ? "wb-icon-btn wb-icon-btn--danger" : "wb-icon-btn",
      attrs: { type: "button", "aria-label": label, title: label },
      dataset: { action }
    },
    [icon(name)]
  );
  element.disabled = options.disabled ?? false;
  return element;
}

/**
 * Reads a named control inside `scope` as text: the checked radio of a group, checkbox state as
 * "true"/"false", otherwise the value.
 */
export function readField(scope: ParentNode, name: string): string {
  const control = scope.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    `[name="${name}"]`
  );

  if (control instanceof HTMLInputElement && control.type === "radio") {
    return (
      scope.querySelector<HTMLInputElement>(`input[type="radio"][name="${name}"]:checked`)?.value ??
      ""
    );
  }

  if (control instanceof HTMLInputElement && control.type === "checkbox") {
    return String(control.checked);
  }

  return control?.value ?? "";
}

export function readCheckbox(scope: ParentNode, name: string): boolean {
  return readField(scope, name) === "true";
}
