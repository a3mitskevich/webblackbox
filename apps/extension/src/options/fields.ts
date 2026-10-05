import { el, uniqueId } from "../shared/ui/dom.js";
import { icon } from "../shared/ui/icons.js";

/**
 * Form building blocks for the settings page: one-line hints, "?" tooltips, numbers with units,
 * sliders and inline errors, chip lists, toggles and section headers. Values are read back by
 * `name` (see dom.ts `readField`); every change bubbles an `input` event so editors can track
 * unsaved changes.
 */

export type FieldText = {
  label: string;
  hint?: string;
  /** Longer explanation behind a "?" button. */
  help?: string;
  /** Accessible name of the "?" button, e.g. "More about Ring buffer". */
  helpLabel?: string;
};

/** Bubbled by a field whose typed-but-uncommitted text is invalid (`error`) or fine (`null`). */
export const PENDING_ERROR_EVENT = "wb-pending-error";

export type PendingErrorDetail = { key: string; error: string | null };

/** Key of a chip list's pending-text error in the page's error map. */
export function pendingErrorKey(name: string): string {
  return `pending:${name}`;
}

/**
 * Shows `error` on a field and tells the page, so an invalid value blocks Save. Keyed by the
 * control's id (or name), so the page can drop the error once the control is gone.
 */
export function reportFieldProblem(control: HTMLElement, error: string | null): void {
  setFieldError(control, error);
  control.dispatchEvent(
    new CustomEvent<PendingErrorDetail>(PENDING_ERROR_EVENT, {
      bubbles: true,
      detail: {
        key: pendingErrorKey(control.id || control.getAttribute("name") || ""),
        error
      }
    })
  );
}

/**
 * Escape hides the "?" bubble that is open by hover or focus (WCAG 1.4.13), until the pointer or
 * focus leaves it.
 */
export function installTooltipDismiss(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const reopen = (event: Event): void => {
    const help = (event.target as Element | null)?.closest?.(".wb-help");
    const next = (event as FocusEvent | PointerEvent).relatedTarget as Node | null;

    if (help && !(next && help.contains(next))) {
      help.classList.remove("wb-help--dismissed");
    }
  };

  doc.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }

    root.querySelectorAll(".wb-help").forEach((help) => {
      if (help.matches(":hover") || help.contains(doc.activeElement)) {
        help.classList.add("wb-help--dismissed");
      }
    });
  });
  root.addEventListener("pointerout", reopen);
  root.addEventListener("focusout", reopen);
}

export function helpTip(label: string, text: string): HTMLElement {
  const bubbleId = uniqueId("wb-help");

  return el("span", { className: "wb-help" }, [
    el("button", {
      className: "wb-help__button",
      text: "?",
      attrs: { type: "button", "aria-label": label, "aria-describedby": bubbleId }
    }),
    el("span", { className: "wb-help__bubble", text, attrs: { role: "tooltip", id: bubbleId } })
  ]);
}

type FieldShellOptions = FieldText & {
  controlId: string;
  control: HTMLElement;
  wide?: boolean;
  /** Elements after the control (e.g. hidden inputs). */
  extra?: HTMLElement[];
};

function fieldShell(options: FieldShellOptions): HTMLElement {
  const head = el("div", { className: "wb-field__head" }, [
    el("label", {
      className: "wb-field__label",
      text: options.label,
      attrs: { for: options.controlId }
    })
  ]);

  if (options.help) {
    head.append(helpTip(options.helpLabel ?? options.label, options.help));
  }

  return el("div", { className: options.wide ? "wb-field wb-field--wide" : "wb-field" }, [
    head,
    options.control,
    ...(options.extra ?? []),
    ...(options.hint
      ? [
          el("p", {
            className: "wb-field__hint",
            text: options.hint,
            attrs: { id: `${options.controlId}-hint` }
          })
        ]
      : []),
    el("p", {
      className: "wb-field__error",
      attrs: { id: `${options.controlId}-error`, role: "alert" }
    })
  ]);
}

function describedBy(controlId: string, hasHint: boolean): string {
  return [hasHint ? `${controlId}-hint` : "", `${controlId}-error`].filter(Boolean).join(" ");
}

/** Shows or clears the inline error of the field that owns `control`. */
export function setFieldError(control: HTMLElement, message: string | null): void {
  const error = control.closest(".wb-field")?.querySelector<HTMLElement>(".wb-field__error");

  if (message) {
    control.setAttribute("aria-invalid", "true");
  } else {
    control.removeAttribute("aria-invalid");
  }

  if (error) {
    error.textContent = message ?? "";
  }
}

export type NumberFieldOptions = FieldText & {
  id: string;
  name?: string;
  value: string;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  /** Adds a range slider bound to the number input (mouse convenience; the input stays primary). */
  slider?: boolean;
  placeholder?: string;
};

export function numberField(options: NumberFieldOptions): HTMLElement {
  const input = el("input", {
    className: "wb-input wb-input--number",
    attrs: {
      type: "number",
      id: options.id,
      name: options.name ?? options.id,
      min: String(options.min),
      max: String(options.max),
      step: String(options.step ?? 1),
      inputmode: "numeric",
      "aria-describedby": describedBy(options.id, Boolean(options.hint)),
      ...(options.placeholder ? { placeholder: options.placeholder } : {})
    }
  });
  input.value = options.value;
  const group = el("div", { className: "wb-input-group" }, [
    input,
    ...(options.unit
      ? [
          el("span", {
            className: "wb-input-group__unit",
            text: options.unit,
            attrs: { "aria-hidden": "true" }
          })
        ]
      : [])
  ]);
  const control = options.slider ? el("div", { className: "wb-slider-row" }, [group]) : group;

  if (options.slider) {
    const range = el("input", {
      className: "wb-range",
      attrs: {
        type: "range",
        min: String(options.min),
        max: String(options.max),
        step: String(options.step ?? 1),
        tabindex: "-1",
        "aria-hidden": "true"
      }
    });
    range.value = options.value || String(options.min);
    range.addEventListener("input", (event) => {
      event.stopPropagation();
      input.value = range.value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    input.addEventListener("input", () => {
      if (input.value !== "" && Number.isFinite(Number(input.value))) {
        range.value = input.value;
      }
    });
    control.prepend(range);
  }

  return fieldShell({ ...options, controlId: options.id, control });
}

export type TextFieldOptions = FieldText & {
  id: string;
  name?: string;
  value: string;
  placeholder?: string;
  wide?: boolean;
  mono?: boolean;
};

export function textField(options: TextFieldOptions): HTMLElement {
  const input = el("input", {
    className: options.mono ? "wb-input mono" : "wb-input",
    attrs: {
      type: "text",
      id: options.id,
      name: options.name ?? options.id,
      autocomplete: "off",
      spellcheck: "false",
      "aria-describedby": describedBy(options.id, Boolean(options.hint)),
      ...(options.placeholder ? { placeholder: options.placeholder } : {})
    }
  });
  input.value = options.value;
  return fieldShell({ ...options, controlId: options.id, control: input });
}

export type SelectFieldOptions = FieldText & {
  id: string;
  name?: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
};

export function selectField(options: SelectFieldOptions): HTMLElement {
  const select = el("select", {
    className: "wb-select",
    attrs: {
      id: options.id,
      name: options.name ?? options.id,
      "aria-describedby": describedBy(options.id, Boolean(options.hint))
    }
  });

  for (const option of options.options) {
    select.append(el("option", { text: option.label, attrs: { value: option.value } }));
  }

  select.value = options.value;
  select.disabled = options.disabled ?? false;
  return fieldShell({ ...options, controlId: options.id, control: select });
}

export type ToggleFieldOptions = FieldText & { id: string; name?: string; checked: boolean };

export function toggleField(options: ToggleFieldOptions): HTMLElement {
  const input = el("input", {
    attrs: {
      type: "checkbox",
      id: options.id,
      name: options.name ?? options.id,
      ...(options.hint ? { "aria-describedby": `${options.id}-hint` } : {})
    }
  });
  input.checked = options.checked;
  const row = el("div", { className: "wb-field wb-field--toggle" }, [
    el("div", { className: "wb-toggle-row" }, [
      input,
      el("label", {
        className: "wb-field__label",
        text: options.label,
        attrs: { for: options.id }
      }),
      ...(options.help ? [helpTip(options.helpLabel ?? options.label, options.help)] : [])
    ])
  ]);

  if (options.hint) {
    row.append(
      el("p", {
        className: "wb-field__hint",
        text: options.hint,
        attrs: { id: `${options.id}-hint` }
      })
    );
  }

  return row;
}

export type ChipListOptions = FieldText & {
  id: string;
  name: string;
  values: readonly string[];
  placeholder: string;
  removeLabel: (value: string) => string;
  duplicateMessage: string;
  maxItems?: number;
  tooManyMessage?: string;
  /** Returns an error message for an invalid entry, or null. */
  validate?: (value: string) => string | null;
};

/**
 * Editable list of short values. Enter adds the typed value (pasting several lines adds each),
 * Backspace on an empty input removes the last chip, leaving the input commits pending text.
 * A hidden input named `options.name` holds the list joined by newlines.
 */
export function chipListField(options: ChipListOptions): HTMLElement {
  let values = [...options.values];
  const list = el("ul", { className: "wb-chips__list", attrs: { "aria-label": options.label } });
  const input = el("input", {
    className: "wb-chips__input",
    attrs: {
      type: "text",
      id: options.id,
      autocomplete: "off",
      spellcheck: "false",
      placeholder: options.placeholder,
      "aria-describedby": describedBy(options.id, Boolean(options.hint))
    }
  });
  const hidden = el("input", { attrs: { type: "hidden", name: options.name } });
  const box = el("div", { className: "wb-chips" }, [list, input]);
  const reportPending = (error: string | null): void => reportFieldProblem(input, error);

  const renderChips = (): void => {
    list.replaceChildren(
      ...values.map((value, index) => {
        const problem = options.validate?.(value) ?? null;
        const remove = el(
          "button",
          {
            className: "wb-chip__remove",
            attrs: { type: "button", "aria-label": options.removeLabel(value) },
            dataset: { chipIndex: String(index) }
          },
          [icon("close")]
        );
        return el(
          "li",
          {
            className: problem ? "wb-chip wb-chip--invalid" : "wb-chip",
            attrs: problem ? { title: problem } : {}
          },
          [el("span", { className: "wb-chip__text", text: value }), remove]
        );
      })
    );
  };

  const publish = (): void => {
    hidden.value = values.join("\n");
    renderChips();
    hidden.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const problemFor = (candidate: string, current: readonly string[]): string | null => {
    if (current.includes(candidate)) {
      return options.duplicateMessage;
    }

    if (options.maxItems !== undefined && current.length >= options.maxItems) {
      return options.tooManyMessage ?? options.duplicateMessage;
    }

    return options.validate?.(candidate) ?? null;
  };

  const add = (raw: string): boolean => {
    const candidates = raw
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    let next = values;

    for (const candidate of candidates) {
      const problem = problemFor(candidate, next);

      if (problem) {
        reportPending(problem);
        return false;
      }

      next = [...next, candidate];
    }

    reportPending(null);

    if (next !== values) {
      values = next;
      publish();
    }

    return true;
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();

      if (add(input.value)) {
        input.value = "";
      }

      return;
    }

    if (event.key === "Backspace" && input.value === "" && values.length > 0) {
      values = values.slice(0, -1);
      publish();
    }
  });
  input.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text") ?? "";

    if (/\r?\n/.test(text)) {
      event.preventDefault();
      add(text);
    }
  });
  input.addEventListener("blur", () => {
    if (input.value.trim() && add(input.value)) {
      input.value = "";
    }
  });
  input.addEventListener("input", (event) => {
    // Typing is not a list change; only chip edits bubble to the page.
    event.stopPropagation();
    reportPending(null);
  });
  list.addEventListener("click", (event) => {
    const remove = (event.target as Element | null)?.closest<HTMLElement>("[data-chip-index]");

    if (!remove) {
      return;
    }

    const index = Number(remove.dataset.chipIndex);
    values = values.filter((_, position) => position !== index);
    publish();
    input.focus();
  });

  hidden.value = values.join("\n");
  renderChips();
  return fieldShell({
    ...options,
    controlId: options.id,
    control: box,
    extra: [hidden],
    wide: true
  });
}

export function sectionHeader(options: {
  id: string;
  title: string;
  hint: string;
  resetLabel?: string;
  /** Text of the badge shown while the section has unsaved changes (hidden until then). */
  unsavedLabel?: string;
}): HTMLElement {
  const unsaved = options.unsavedLabel
    ? el("span", {
        className: "wb-badge wb-badge--unsaved",
        text: options.unsavedLabel,
        dataset: { sectionUnsaved: "" }
      })
    : null;

  if (unsaved) {
    unsaved.hidden = true;
  }

  return el("header", { className: "wb-section__header" }, [
    el("div", { className: "wb-section__heading" }, [
      el("div", { className: "wb-section__title-row" }, [
        el("h2", {
          className: "wb-section__title",
          text: options.title,
          attrs: { id: `${options.id}-title` }
        }),
        ...(unsaved ? [unsaved] : [])
      ]),
      el("p", { className: "wb-section__hint", text: options.hint })
    ]),
    ...(options.resetLabel
      ? [
          el("button", {
            className: "wb-btn wb-btn--ghost wb-btn--small",
            text: options.resetLabel,
            attrs: { type: "button" },
            dataset: { action: "section-reset", section: options.id }
          })
        ]
      : [])
  ]);
}

/** Titled group of fields inside a section, laid out as a responsive grid. */
export function fieldGroup(
  title: string | null,
  fields: HTMLElement[],
  note?: string
): HTMLElement {
  return el("div", { className: "wb-group" }, [
    ...(title ? [el("h3", { className: "wb-group__title", text: title })] : []),
    ...(note ? [el("p", { className: "wb-field__hint", text: note })] : []),
    el("div", { className: "wb-grid" }, fields)
  ]);
}

/** True when `selector` parses (invalid selectors throw from querySelector). */
export function isValidSelector(selector: string): boolean {
  try {
    document.createDocumentFragment().querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

/** RFC 7230 header field-name token. */
export function isValidHeaderName(name: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name);
}

/** `type/subtype`; `*` may stand in the subtype (`text/*`, `application/*+json`). */
export function isValidMimeType(value: string): boolean {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9*][a-z0-9!#$&^_.+*-]*$/i.test(value);
}
