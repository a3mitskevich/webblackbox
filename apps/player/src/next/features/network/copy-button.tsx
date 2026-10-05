import { useEffect, useRef, useState } from "react";

import { Icon } from "../../components/icon.js";
import { useFeatureI18n } from "../messages.js";
import { networkMessages } from "./messages.js";

/** How long "Copied" stays next to the button. */
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
export function useCopyStatus(): [CopyStatus, (text: string | null) => Promise<void>] {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
    },
    []
  );

  const copy = async (text: string | null): Promise<void> => {
    if (text === null) {
      return;
    }

    const ok = await copyToClipboard(text);
    setStatus(ok ? "copied" : "failed");

    if (timer.current !== null) {
      window.clearTimeout(timer.current);
    }

    timer.current = window.setTimeout(() => setStatus("idle"), COPIED_MS);
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

  return (
    <span className="ncopy">
      <button
        type="button"
        className={compact ? "btn small icon-only" : "btn small"}
        disabled={disabled}
        aria-label={compact ? label : undefined}
        onClick={() => void copy(getText())}
        data-testid={testId}
      >
        <Icon name="copy" />
        {compact ? null : <span>{label}</span>}
      </button>
      <span
        className="ncopy-status"
        role="status"
        data-testid={testId ? `${testId}-status` : undefined}
      >
        {status === "copied" ? t("copied") : status === "failed" ? t("copyFailed") : ""}
      </span>
    </span>
  );
}
