import { Toast } from "@base-ui/react/toast";

import "./toasts.css";

import { useI18n } from "../context.js";
import { Icon } from "./icon.js";

/** How long a notice stays up when the user does not interact with it. */
const TOAST_TIMEOUT_MS = 6_000;
const TOAST_LIMIT = 3;

/**
 * The player's one toast manager (Base UI `Toast`): any feature adds a notice with
 * `toastManager.add({ title, description, actionProps })` — "Copied curl", "export ready", a
 * filter that was relaxed to show the selection. The host below renders them in a polite live
 * region; positioning uses element styles only (no injected `<style>`).
 */
export const toastManager = Toast.createToastManager();

function ToastList() {
  const i18n = useI18n();
  const { toasts } = Toast.useToastManager();

  return toasts.map((toast) => (
    <Toast.Root key={toast.id} toast={toast} className="toast" data-testid="toast">
      <Toast.Content className="toast-content">
        <Toast.Title className="toast-title" />
        <Toast.Description className="toast-description" />
      </Toast.Content>
      {toast.actionProps ? <Toast.Action className="btn small" data-testid="toast-action" /> : null}
      <Toast.Close className="btn icon-only small" aria-label={i18n.tn("toastClose")}>
        <Icon name="close" />
      </Toast.Close>
    </Toast.Root>
  ));
}

/** Rendered once by the app shell. */
export function ToastHost() {
  return (
    <Toast.Provider toastManager={toastManager} timeout={TOAST_TIMEOUT_MS} limit={TOAST_LIMIT}>
      <Toast.Portal>
        <Toast.Viewport className="toast-viewport" data-testid="toast-viewport">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
