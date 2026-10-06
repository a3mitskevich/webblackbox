import { Suspense, type ReactNode } from "react";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";

import { useI18n } from "../context.js";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function PanelFailed({ error, resetErrorBoundary }: FallbackProps) {
  const i18n = useI18n();

  return (
    <div className="panel-failed" role="alert" data-testid="panel-failed">
      <p>{i18n.tn("panelFailed", { error: errorText(error) })}</p>
      <button type="button" className="btn small" onClick={resetErrorBoundary}>
        {i18n.tn("panelRetry")}
      </button>
    </div>
  );
}

function PanelLoading() {
  const i18n = useI18n();

  return (
    <p className="status-line" role="status" data-testid="panel-loading">
      <span className="spinner" aria-hidden="true" />
      {i18n.tn("panelLoading")}
    </p>
  );
}

type PanelBoundaryProps = {
  /** The boundary resets when one of these changes (e.g. another archive or tab). */
  resetKeys?: readonly unknown[];
  children: ReactNode;
};

/**
 * One panel's isolation: a render error degrades this panel to "failed, retry" instead of
 * blanking the player, and a lazily loaded panel shows a loading line while its chunk arrives.
 */
export function PanelBoundary({ resetKeys, children }: PanelBoundaryProps) {
  return (
    <ErrorBoundary
      FallbackComponent={PanelFailed}
      resetKeys={resetKeys ? [...resetKeys] : undefined}
    >
      <Suspense fallback={<PanelLoading />}>{children}</Suspense>
    </ErrorBoundary>
  );
}
