import { useEffect, useRef, useState } from "react";

import { Icon } from "../../components/icon.js";
import { toastManager } from "../../components/toasts.js";
import { useFeatureI18n } from "../messages.js";
import { networkMessages } from "./messages.js";

/** How long the copy status stays in the button's (test) hook. */
const COPIED_MS = 1_600;

export type CopyStatus = "idle" | "copied" | "failed";

/** Writes text to the clipboard; reports the result instead of throwing (no permission, http:). */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** A copy action with its own short-lived status ("Copied" / "Could not copy"). */
export function useCopyStatus(): [CopyStatus, (text: string | null) => Promise<CopyStatus>] {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const timer = useRef<number | null>(null);
  const isMounted = useRef(false);

  useEffect(() => {
    isMounted.current = true;

    return () => {
      isMounted.current = false;

      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
    };
  }, []);

  const copy = async (text: string | null): Promise<CopyStatus> => {
    if (text === null) {
      return "idle";
    }

    const ok = await copyToClipboard(text);
    const result: CopyStatus = ok ? "copied" : "failed";

    // The clipboard answers asynchronously: the button may be gone by then (another request).
    if (!isMounted.current) {
      return result;
    }

    setStatus(result);

    if (timer.current !== null) {
      window.clearTimeout(timer.current);
    }

    timer.current = window.setTimeout(() => setStatus("idle"), COPIED_MS);
    return result;
  };

  return [status, copy];
}

type CopyButtonProps = {
  label: string;
  /** The text to copy, read on click (`null` copies nothing). */
  getText: () => string | null;
  testId?: string;
  disabled?: boolean;
  /** Icon only (the label becomes the accessible name). */
  compact?: boolean;
};

export function CopyButton({
  label,
  getText,
  testId,
  disabled = false,
  compact = false
}: CopyButtonProps) {
  const t = useFeatureI18n(networkMessages);
  const [status, copy] = useCopyStatus();

  const handleClick = async (): Promise<void> => {
    const result = await copy(getText());

    // The player's toasts carry the feedback (a polite live region, shared with other features).
    if (result !== "idle") {
      toastManager.add({
        title: result === "copied" ? t("copied") : t("copyFailed"),
        description: label
      });
    }
  };

  return (
    <span className="ncopy">
      <button
        type="button"
        className={compact ? "btn small icon-only" : "btn small"}
        disabled={disabled}
        aria-label={compact ? label : undefined}
        onClick={() => void handleClick()}
        data-testid={testId}
      >
        <Icon name="copy" />
        {compact ? null : <span>{label}</span>}
      </button>
      {/* The result for tests and scripts; people get the toast. */}
      <span className="visually-hidden" data-testid={testId ? `${testId}-status` : undefined}>
        {status === "copied" ? t("copied") : status === "failed" ? t("copyFailed") : ""}
      </span>
    </span>
  );
}
