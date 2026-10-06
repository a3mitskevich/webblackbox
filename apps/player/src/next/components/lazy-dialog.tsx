import { lazy, Suspense, useState, type ComponentType, type LazyExoticComponent } from "react";
import { ErrorBoundary } from "react-error-boundary";

import { useI18n } from "../context.js";
import { toastManager } from "./toasts.js";

type DialogModule = { default: ComponentType };

/** A dialog component for one load attempt; a new attempt gets a fresh `lazy()`. */
export type RetryableLazy = (attempt: number) => LazyExoticComponent<ComponentType>;

/**
 * `React.lazy` caches a rejected import for good (a stale content-hashed chunk after a deploy), so
 * a retry needs a new lazy component: this keeps one per attempt and loads again on the next.
 */
export function retryableLazy(load: () => Promise<DialogModule>): RetryableLazy {
  let current = { attempt: 0, component: lazy(load) };

  return (attempt) => {
    if (current.attempt !== attempt) {
      current = { attempt, component: lazy(load) };
    }

    return current.component;
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type LazyDialogProps = {
  open: boolean;
  dialog: RetryableLazy;
  /** Drops the open flag after a failure, so the player stays usable. */
  onClose: () => void;
  /** Opens the dialog again (the toast's "Retry"), with a fresh load of its chunk. */
  onReopen: () => void;
};

/**
 * A lazily loaded dialog's isolation: a chunk that fails to load or a dialog that throws while
 * rendering closes this dialog and shows a "failed, retry" toast instead of unmounting the player
 * (and the loaded archive with it).
 */
export function LazyDialog({ open, dialog, onClose, onReopen }: LazyDialogProps) {
  const i18n = useI18n();
  const [attempt, setAttempt] = useState(0);

  if (!open) {
    return null;
  }

  const Dialog = dialog(attempt);

  const handleError = (error: unknown): void => {
    // Any later open (Retry, Ctrl+K, the menu) loads the chunk afresh: React keeps a rejected
    // lazy() import for good.
    setAttempt((current) => current + 1);
    onClose();
    toastManager.add({
      title: i18n.tn("panelFailed", { error: errorText(error) }),
      actionProps: {
        children: i18n.tn("panelRetry"),
        onClick: onReopen
      }
    });
  };

  return (
    <ErrorBoundary fallback={null} onError={handleError}>
      <Suspense fallback={null}>
        <Dialog />
      </Suspense>
    </ErrorBoundary>
  );
}
