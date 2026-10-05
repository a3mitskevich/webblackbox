import { useEffect, useRef, type ReactNode } from "react";

type ModalDialogProps = {
  open: boolean;
  /** Called when the dialog is dismissed (Esc, backdrop-less close). */
  onClose: () => void;
  labelledBy: string;
  describedBy?: string;
  className?: string;
  testId?: string;
  children: ReactNode;
};

/**
 * A native `<dialog>` opened with `showModal()` (focus trap and Esc for free). Focus returns to the
 * element that was focused before it opened (PROPOSAL §7).
 */
export function ModalDialog({
  open,
  onClose,
  labelledBy,
  describedBy,
  className,
  testId,
  children
}: ModalDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = ref.current;

    if (!dialog || !open) {
      return;
    }

    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    if (!dialog.open) {
      // jsdom has no showModal(); the open attribute keeps tests working.
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
    }

    const handleCancel = (event: Event): void => {
      event.preventDefault();
      onCloseRef.current();
    };

    dialog.addEventListener("cancel", handleCancel);

    return () => {
      dialog.removeEventListener("cancel", handleCancel);

      if (dialog.open) {
        if (typeof dialog.close === "function") {
          dialog.close();
        } else {
          dialog.removeAttribute("open");
        }
      }

      opener?.focus();
    };
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <dialog
      ref={ref}
      className={className ? `dlg ${className}` : "dlg"}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      data-testid={testId}
    >
      {children}
    </dialog>
  );
}
