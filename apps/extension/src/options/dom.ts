/** Small DOM builders for the options editors (no innerHTML: every value is user data). */

type ElementOptions = {
  className?: string;
  text?: string;
  attrs?: Record<string, string>;
  dataset?: Record<string, string>;
};

export function el<TTag extends keyof HTMLElementTagNameMap>(
  tag: TTag,
  options: ElementOptions = {},
  children: Array<Node | string> = []
): HTMLElementTagNameMap[TTag] {
  const element = document.createElement(tag);

  if (options.className) {
    element.className = options.className;
  }

  if (options.text !== undefined) {
    element.textContent = options.text;
  }

  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    element.setAttribute(name, value);
  }

  Object.assign(element.dataset, options.dataset ?? {});
  element.append(...children);
  return element;
}

export function button(
  text: string,
  action: string,
  variant: "brand" | "muted" | "surface" | "accent" = "surface"
): HTMLButtonElement {
  const element = el("button", {
    className: `wb-btn wb-btn--${variant}`,
    text,
    attrs: { type: "button" },
    dataset: { action }
  });
  return element;
}

export function labeledInput(
  label: string,
  name: string,
  value: string,
  type: "text" | "number" = "text"
): HTMLLabelElement {
  const input = el("input", { className: "wb-input", attrs: { type, name } });
  input.value = value;
  return el("label", { className: "wb-options-field-label" }, [label, input]);
}

export function labeledTextarea(label: string, name: string, value: string): HTMLLabelElement {
  const textarea = el("textarea", { className: "wb-options-textarea", attrs: { name, rows: "3" } });
  textarea.value = value;
  return el("label", { className: "wb-options-field-label" }, [label, textarea]);
}

export function labeledSelect(
  label: string,
  name: string,
  value: string,
  options: Array<{ value: string; label: string }>
): HTMLLabelElement {
  const select = el("select", { className: "wb-input", attrs: { name } });

  for (const option of options) {
    select.append(el("option", { text: option.label, attrs: { value: option.value } }));
  }

  select.value = value;
  return el("label", { className: "wb-options-field-label" }, [label, select]);
}

export function labeledCheckbox(label: string, name: string, checked: boolean): HTMLElement {
  const input = el("input", { attrs: { type: "checkbox", name } });
  input.checked = checked;
  return el("label", { className: "wb-options-checkbox-row" }, [input, label]);
}

/** Reads a named control inside `scope` as text (or checkbox state as "true"/"false"). */
export function readField(scope: ParentNode, name: string): string {
  const control = scope.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    `[name="${name}"]`
  );

  if (control instanceof HTMLInputElement && control.type === "checkbox") {
    return String(control.checked);
  }

  return control?.value ?? "";
}

export function readCheckbox(scope: ParentNode, name: string): boolean {
  return readField(scope, name) === "true";
}
