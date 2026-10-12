/**
 * Full → Light fallback: when the Full engine (the debugger) cannot run or stops, the recording
 * goes on with page-side capture instead of ending, and says when and why.
 */

/** Why a recording left the Full engine. */
export type CaptureFallbackReason =
  /** Browser pages, the Web Store and other extensions' pages refuse the debugger. */
  | "restricted-page"
  /** `chrome.debugger.attach` failed (another debugger, a policy, a crashed page). */
  | "attach-failed"
  /** The user pressed "Cancel" on Chrome's "started debugging this browser" bar. */
  | "canceled-by-user"
  /** The debugged page went away while the tab stayed. */
  | "target-closed"
  /** Any other detach Chrome reports. */
  | "detached";

export type CaptureFallback = {
  /** When the Full engine stopped, epoch ms. */
  at: number;
  reason: CaptureFallbackReason;
  from: "full";
  to: "lite";
  /** Chrome's own reason or error text, when it says more than `reason`. */
  detail?: string;
};

export const CAPTURE_FALLBACK_REASONS: readonly CaptureFallbackReason[] = [
  "restricted-page",
  "attach-failed",
  "canceled-by-user",
  "target-closed",
  "detached"
];

const MAX_DETAIL_LENGTH = 200;

/** Schemes the debugger cannot attach to (about:blank and about:srcdoc are fine). */
const RESTRICTED_SCHEME =
  /^(chrome|chrome-untrusted|chrome-search|chrome-extension|devtools|edge|view-source):/i;
const RESTRICTED_ABOUT = /^about:(?!blank\b|srcdoc\b)/i;
const WEB_STORE_HOSTS = new Set(["chromewebstore.google.com"]);
const LEGACY_WEB_STORE = { host: "chrome.google.com", pathPrefix: "/webstore" };

/** Pages Chrome never lets an extension debug: Full cannot start there. */
export function isDebuggerRestrictedUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }

  if (RESTRICTED_SCHEME.test(url) || RESTRICTED_ABOUT.test(url)) {
    return true;
  }

  try {
    const parsed = new URL(url);

    return (
      WEB_STORE_HOSTS.has(parsed.hostname) ||
      (parsed.hostname === LEGACY_WEB_STORE.host &&
        parsed.pathname.startsWith(LEGACY_WEB_STORE.pathPrefix))
    );
  } catch {
    return false;
  }
}

/** Maps `chrome.debugger.onDetach`'s reason to a fallback reason. */
export function toCaptureFallbackReason(detachReason: string): CaptureFallbackReason {
  switch (detachReason) {
    case "canceled_by_user":
      return "canceled-by-user";
    case "target_closed":
      return "target-closed";
    default:
      return "detached";
  }
}

export function createCaptureFallback(input: {
  at: number;
  reason: CaptureFallbackReason;
  detail?: string;
}): CaptureFallback {
  const detail = input.detail?.trim().slice(0, MAX_DETAIL_LENGTH);

  return {
    at: input.at,
    reason: input.reason,
    from: "full",
    to: "lite",
    ...(detail ? { detail } : {})
  };
}

/** A stored or messaged fallback (untrusted shape); undefined when it is not one. */
export function parseCaptureFallback(value: unknown): CaptureFallback | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const row = value as Record<string, unknown>;

  if (
    typeof row.at !== "number" ||
    !Number.isFinite(row.at) ||
    !CAPTURE_FALLBACK_REASONS.includes(row.reason as CaptureFallbackReason) ||
    row.from !== "full" ||
    row.to !== "lite"
  ) {
    return undefined;
  }

  return createCaptureFallback({
    at: row.at,
    reason: row.reason as CaptureFallbackReason,
    ...(typeof row.detail === "string" ? { detail: row.detail } : {})
  });
}

/**
 * The recording ran in Full: it still does, or it fell back to Light after Full started (a
 * restricted page never ran in Full). Visuals and the tab video it recorded stay its own.
 */
export function ranInFullEngine(session: {
  mode: "lite" | "full";
  captureFallback?: CaptureFallback;
}): boolean {
  return (
    session.mode === "full" ||
    (session.captureFallback !== undefined && session.captureFallback.reason !== "restricted-page")
  );
}
