import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { useController, useI18n, usePlayerState } from "../context.js";
import { ArchiveInput } from "./header.js";
import { Icon } from "./icon.js";
import { DialogDescription, DialogTitle, ModalDialog } from "./modal-dialog.js";

/** Loading / error line shared by the empty state and the loaded layout. */
export function ArchiveStatusLine() {
  const controller = useController();
  const i18n = useI18n();
  const status = usePlayerState((state) => state.status);

  if (status.phase === "loading") {
    return (
      <p className="status-line" role="status" data-testid="archive-loading">
        <span className="spinner" aria-hidden="true" />
        {i18n.tn("loading", { fileName: status.fileName })}
      </p>
    );
  }

  if (status.phase === "error") {
    return (
      <div className="status-line bad" role="alert" data-testid="archive-error">
        <Icon name="error" />
        <span>{i18n.tn("loadFailed", { fileName: status.fileName, error: status.message })}</span>
        <button type="button" className="btn small" onClick={() => controller.dismissError()}>
          {i18n.tn("close")}
        </button>
      </div>
    );
  }

  return null;
}

/** Start screen: what to do, a file button, and the whole page as a drop target. */
export function EmptyState() {
  const i18n = useI18n();
  const titleId = useId();

  return (
    <section className="empty" aria-labelledby={titleId} data-testid="empty-state">
      <div className="empty-card">
        <span className="empty-icon" aria-hidden="true">
          <Icon name="media" className="ic ic-lg" />
        </span>
        <h1 id={titleId}>{i18n.tn("emptyTitle")}</h1>
        <p>{i18n.tn("emptyBody")}</p>
        <ArchiveInput
          className="btn primary large"
          label={i18n.tn("chooseFile")}
          testId="empty-archive-input"
        />
        <ArchiveStatusLine />
      </div>
    </section>
  );
}

export function DropOverlay() {
  const i18n = useI18n();
  const active = usePlayerState((state) => state.dragActive);

  if (!active) {
    return null;
  }

  return (
    <div className="drop-overlay" data-testid="drop-overlay" aria-hidden="true">
      <div className="drop-card">
        <Icon name="file" className="ic ic-lg" />
        <span>{i18n.tn("dropHere")}</span>
      </div>
    </div>
  );
}

export function PassphraseDialog() {
  const controller = useController();
  const i18n = useI18n();
  const status = usePlayerState((state) => state.status);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const open = status.phase === "passphrase";
  const invalid = open && status.invalid;

  // A wrong passphrase keeps the dialog open: clear the field and focus it again.
  useEffect(() => {
    if (open) {
      setValue("");
      inputRef.current?.focus();
    }
  }, [open, invalid]);

  if (!open) {
    return null;
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (value.trim().length > 0) {
      controller.submitPassphrase(value);
    }
  };

  return (
    <ModalDialog
      open
      onClose={() => controller.cancelPassphrase()}
      initialFocus={inputRef}
      disablePointerDismissal
      testId="passphrase-dialog"
    >
      <form className="dlg-body" onSubmit={submit}>
        <DialogTitle>
          <Icon name="lock" />
          {i18n.tn("passphraseTitle")}
        </DialogTitle>
        <DialogDescription>
          {i18n.tn("passphrasePrompt", { fileName: status.fileName })}
        </DialogDescription>
        {invalid ? (
          <p className="field-error" role="alert" data-testid="passphrase-invalid">
            {i18n.tn("passphraseInvalid")}
          </p>
        ) : null}
        <label className="field-label">
          {i18n.tn("passphraseLabel")}
          <input
            ref={inputRef}
            className="text-input"
            type="password"
            autoComplete="off"
            value={value}
            aria-invalid={invalid}
            onChange={(event) => setValue(event.target.value)}
            data-testid="passphrase-input"
          />
        </label>
        <div className="dlg-actions">
          <button type="button" className="btn" onClick={() => controller.cancelPassphrase()}>
            {i18n.tn("cancel")}
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={value.trim().length === 0}
            data-testid="passphrase-submit"
          >
            {i18n.tn("passphraseOpen")}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
