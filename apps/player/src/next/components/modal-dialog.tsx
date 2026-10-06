import { Dialog } from "@base-ui/react/dialog";
import type { ReactNode, RefObject } from "react";

type ModalDialogProps = {
  open: boolean;
  /** Called when the dialog is dismissed (Esc, a click outside, a close button). */
  onClose: () => void;
  className?: string;
  testId?: string;
  /** The element focused on open; by default the first tabbable element of the dialog. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Only Esc or a button closes it: a stray click outside must not discard what was typed. */
  disablePointerDismissal?: boolean;
  children: ReactNode;
};

/**
 * A modal dialog on Base UI `Dialog`: focus trap, Esc, inert background and focus returned to the
 * element that opened it (PROPOSAL §7). Name it with `<DialogTitle>` (and `<DialogDescription>`),
 * which Base UI wires to `aria-labelledby` / `aria-describedby`. No injected styles: the backdrop
 * and popup are styled by `.dlg-backdrop` / `.dlg` in next.css, scroll lock uses element.style.
 */
export function ModalDialog({
  open,
  onClose,
  className,
  testId,
  initialFocus,
  disablePointerDismissal = false,
  children
}: ModalDialogProps) {
  return (
    <Dialog.Root
      open={open}
      disablePointerDismissal={disablePointerDismissal}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="dlg-backdrop" />
        <Dialog.Popup
          className={className ? `dlg ${className}` : "dlg"}
          initialFocus={initialFocus}
          data-testid={testId}
        >
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const DialogTitle = Dialog.Title;
export const DialogDescription = Dialog.Description;
