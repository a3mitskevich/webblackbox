import { isValidExportPassphrase } from "@webblackbox/protocol/archive-encryption";

import { el } from "./dom.js";

/**
 * Modal dialogs shared by the popup and the sessions page: role=dialog, focus kept inside while
 * open, Escape / backdrop cancel, focus restored afterwards.
 */

type ButtonVariant = "brand" | "accent" | "muted" | "surface" | "danger";

type DialogFrame = {
  card: HTMLElement;
  /** Element focused when the dialog opens. */
  initialFocus?: HTMLElement;
};

function openDialog<TResult>(
  cancelValue: TResult,
  build: (finish: (value: TResult) => void) => DialogFrame
): Promise<TResult> {
  return new Promise((resolve) => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = el("div", { className: "wb-confirm-overlay" });
    let finished = false;

    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(cancelValue);
        return;
      }

      if (event.key === "Tab") {
        trapFocus(overlay, event);
      }
    };

    function finish(value: TResult): void {
      if (finished) {
        return;
      }

      finished = true;
      overlay.remove();
      document.removeEventListener("keydown", onKeydown, true);

      if (previousFocus?.isConnected) {
        previousFocus.focus();
      }

      resolve(value);
    }

    const frame = build(finish);

    frame.card.setAttribute("role", "dialog");
    frame.card.setAttribute("aria-modal", "true");
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        finish(cancelValue);
      }
    });
    overlay.append(frame.card);
    document.addEventListener("keydown", onKeydown, true);
    document.body.append(overlay);
    frame.initialFocus?.focus();
  });
}

function trapFocus(container: HTMLElement, event: KeyboardEvent): void {
  const focusable = [
    ...container.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])")
  ];
  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (!first || !last) {
    return;
  }

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function dialogButton(
  label: string,
  variant: ButtonVariant,
  dataset: Record<string, string>,
  type: "button" | "submit" = "button"
): HTMLButtonElement {
  return el("button", {
    className: `wb-btn wb-btn--${variant}`,
    text: label,
    attrs: { type },
    dataset
  });
}

function dialogHeading(id: string, title: string, body: string, detail?: string): HTMLElement[] {
  return [
    el("h2", { className: "wb-confirm-title", text: title, attrs: { id } }),
    ...(detail ? [el("p", { className: "wb-confirm-body mono", text: detail })] : []),
    el("p", { className: "wb-confirm-body", text: body })
  ];
}

export type PassphraseDialogOptions = {
  title: string;
  body: string;
  label: string;
  submitLabel: string;
  cancelLabel: string;
  /** Shown on the input while the passphrase is too short to encrypt an export. */
  requiredMessage: string;
  /** Optional monospace line, e.g. the session id. */
  detail?: string;
};

/**
 * Resolves the typed passphrase, or null when cancelled. Archives are always encrypted, so it
 * only resolves with a passphrase long enough to encrypt an export.
 */
export function openPassphraseDialog(options: PassphraseDialogOptions): Promise<string | null> {
  return openDialog<string | null>(null, (finish) => {
    const input = el("input", {
      className: "wb-input wb-prompt-field",
      attrs: { id: "wb-passphrase-input", type: "password", autocomplete: "off" }
    });
    const submit = (): void => {
      if (!isValidExportPassphrase(input.value)) {
        input.setCustomValidity(options.requiredMessage);
        input.reportValidity();
        return;
      }

      finish(input.value);
    };
    const cancelButton = dialogButton(options.cancelLabel, "muted", { passphraseCancel: "" });
    const submitButton = dialogButton(options.submitLabel, "accent", { passphraseSubmit: "" });
    const form = el(
      "form",
      {
        className: "wb-confirm-card wb-prompt-card",
        attrs: { "aria-labelledby": "wb-passphrase-title" }
      },
      [
        ...dialogHeading("wb-passphrase-title", options.title, options.body, options.detail),
        el("label", {
          className: "wb-field-label",
          text: options.label,
          attrs: { for: "wb-passphrase-input" }
        }),
        input,
        el("div", { className: "wb-confirm-actions" }, [cancelButton, submitButton])
      ]
    );

    cancelButton.addEventListener("click", () => finish(null));
    submitButton.addEventListener("click", submit);
    input.addEventListener("input", () => input.setCustomValidity(""));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submit();
    });

    return { card: form, initialFocus: input };
  });
}

export type ConfirmDialogOptions = {
  title: string;
  body: string;
  acceptLabel: string;
  cancelLabel: string;
  acceptVariant?: ButtonVariant;
};

export function openConfirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return openDialog<boolean>(false, (finish) => {
    const cancelButton = dialogButton(options.cancelLabel, "muted", { confirmCancel: "" });
    const acceptButton = dialogButton(options.acceptLabel, options.acceptVariant ?? "brand", {
      confirmAccept: ""
    });
    const card = el(
      "section",
      { className: "wb-confirm-card", attrs: { "aria-labelledby": "wb-confirm-title" } },
      [
        ...dialogHeading("wb-confirm-title", options.title, options.body),
        el("div", { className: "wb-confirm-actions" }, [cancelButton, acceptButton])
      ]
    );

    cancelButton.addEventListener("click", () => finish(false));
    acceptButton.addEventListener("click", () => finish(true));

    return { card, initialFocus: cancelButton };
  });
}

export type DialogChoice<TValue extends string> = {
  value: TValue;
  label: string;
  action: string;
  variant: ButtonVariant;
  /** Submit button, focused on open. */
  primary?: boolean;
};

/** A dialog with several outcomes; resolves the chosen value or null when cancelled. */
export function openChoiceDialog<TValue extends string>(options: {
  title: string;
  body: string;
  cancelLabel: string;
  cancelAction: string;
  choices: Array<DialogChoice<TValue>>;
}): Promise<TValue | null> {
  return openDialog<TValue | null>(null, (finish) => {
    const cancelButton = dialogButton(options.cancelLabel, "muted", {
      action: options.cancelAction
    });
    const buttons = options.choices.map((choice) => {
      const element = dialogButton(
        choice.label,
        choice.variant,
        { action: choice.action },
        choice.primary ? "submit" : "button"
      );
      element.addEventListener("click", (event) => {
        event.preventDefault();
        finish(choice.value);
      });
      return { choice, element };
    });
    const form = el(
      "form",
      { className: "wb-confirm-card", attrs: { "aria-labelledby": "wb-choice-title" } },
      [
        ...dialogHeading("wb-choice-title", options.title, options.body),
        el("div", { className: "wb-confirm-actions" }, [
          cancelButton,
          ...buttons.map((entry) => entry.element)
        ])
      ]
    );
    const primary = buttons.find((entry) => entry.choice.primary);

    cancelButton.addEventListener("click", () => finish(null));
    form.addEventListener("submit", (event) => {
      event.preventDefault();

      if (primary) {
        finish(primary.choice.value);
      }
    });

    return { card: form, initialFocus: primary?.element ?? cancelButton };
  });
}
