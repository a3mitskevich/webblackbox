import type { WebBlackboxEvent } from "@webblackbox/protocol";

/** What a recording profile hid, as recorded by a `privacy.violation` event. */
export type PrivacyViolationSubject =
  | "console-text"
  | "console"
  | "network-body"
  | "input-value"
  | "input"
  | "raw-dom"
  | "dom"
  | "screenshot"
  | "tab-recording"
  | "storage"
  | "storage-details"
  | "tabs"
  | "tab-details"
  | "profile"
  | "unknown";

export type PrivacyViolationInfo = {
  /** Event type the profile blocked (e.g. `console.entry`). */
  blockedType?: string;
  reason?: string;
  subject: PrivacyViolationSubject;
};

/** One profile period of a session, from the `meta.config` events written by the extension. */
export type RecordingProfileEntry = {
  t: number;
  mono: number;
  id: string;
  name: string;
  source?: string;
  ruleId?: string;
  ruleName?: string;
  extended: boolean;
  /** Archives recorded before extended profiles ran on every host: what was asked for. */
  downgradedFrom?: { id: string; name: string; reason?: string };
  /** Categories the enterprise policy capped below what the profile asks for. */
  enterpriseCapped?: string[];
};

/** A recording the extension stopped because its effective profile changed. */
export type ProfileCancellationInfo = {
  t: number;
  mono: number;
  /** `rule-changed`, `profile-missing`, `profile-edited` or `enterprise-policy`. */
  reason: string;
  trigger?: string;
  started?: { id: string; name: string };
  next?: { id: string; name: string };
};

/**
 * The recording left the Full engine (the debugger) and went on with page-side (Light) capture:
 * a browser page refused the debugger, it could not attach, the user cancelled Chrome's debugging
 * bar, or the debugger detached. From then on bodies, full console, screenshots and DevTools data
 * are missing.
 */
export type CaptureFallbackInfo = {
  /** When Full stopped, epoch ms (the event time when the record has none). */
  at: number;
  mono: number;
  /** `restricted-page`, `attach-failed`, `canceled-by-user`, `target-closed` or `detached`. */
  reason: string;
  from: string;
  to: string;
  /** Chrome's own reason or error text. */
  detail?: string;
};

const SUBJECT_BY_REASON: Record<string, PrivacyViolationSubject> = {
  "console-payload-disabled": "console-text",
  "console-disabled": "console",
  "network-body-disabled": "network-body",
  "raw-input-value-disabled": "input-value",
  "inputs-disabled": "input",
  "dom-raw-snapshot-disabled": "raw-dom",
  "dom-disabled": "dom",
  "screenshots-disabled": "screenshot",
  "screen-recordings-disabled": "tab-recording",
  "storage-disabled": "storage",
  "storage-detail-disabled": "storage-details",
  "tabs-context-disabled": "tabs",
  "tabs-context-detail-disabled": "tab-details",
  "heap-profile-disabled": "profile",
  "cdp-profile-disabled": "profile"
};
const MAX_TEXT = 200;
const MAX_CAPPED_CATEGORIES = 20;

/** Reads a `privacy.violation` payload (untrusted archive data) into a display-ready shape. */
export function describePrivacyViolation(event: WebBlackboxEvent): PrivacyViolationInfo | null {
  if (event.type !== "privacy.violation") {
    return null;
  }

  const data = asRecord(event.data);
  const reason = readText(data?.reason);
  const blockedType = readText(data?.blockedType);

  return {
    ...(blockedType ? { blockedType } : {}),
    ...(reason ? { reason } : {}),
    subject:
      (reason && Object.hasOwn(SUBJECT_BY_REASON, reason) && SUBJECT_BY_REASON[reason]) || "unknown"
  };
}

/** Recording profiles a session ran under, in time order (consecutive duplicates collapsed). */
export function readRecordingProfiles(
  events: readonly WebBlackboxEvent[]
): RecordingProfileEntry[] {
  const entries: RecordingProfileEntry[] = [];

  for (const event of events) {
    if (event.type !== "meta.config") {
      continue;
    }

    const profile = asRecord(asRecord(event.data)?.profile);
    const id = readText(profile?.id);
    const name = readText(profile?.name);

    if (!id || !name) {
      continue;
    }

    const previous = entries[entries.length - 1];
    const ruleId = readText(profile?.ruleId);

    if (previous && previous.id === id && previous.ruleId === ruleId) {
      continue;
    }

    const downgraded = asRecord(profile?.downgradedFrom);
    const downgradedId = readText(downgraded?.id);
    const downgradedName = readText(downgraded?.name);
    const source = readText(profile?.source);
    const ruleName = readText(profile?.ruleName);
    const downgradeReason = readText(downgraded?.reason);
    const enterpriseCapped = readTextList(profile?.enterpriseCapped);

    entries.push({
      t: event.t,
      mono: event.mono,
      id,
      name,
      ...(source ? { source } : {}),
      ...(ruleId ? { ruleId } : {}),
      ...(ruleName ? { ruleName } : {}),
      extended: profile?.extended === true,
      ...(downgradedId && downgradedName
        ? {
            downgradedFrom: {
              id: downgradedId,
              name: downgradedName,
              ...(downgradeReason ? { reason: downgradeReason } : {})
            }
          }
        : {}),
      ...(enterpriseCapped.length > 0 ? { enterpriseCapped } : {})
    });
  }

  return entries;
}

/**
 * The `meta.config.profileCancel` record, if the extension stopped the recording because its
 * profile changed (untrusted archive data, read defensively). Null for other archives.
 */
export function readProfileCancellation(
  events: readonly WebBlackboxEvent[]
): ProfileCancellationInfo | null {
  for (const event of events) {
    if (event.type !== "meta.config") {
      continue;
    }

    const cancel = asRecord(asRecord(event.data)?.profileCancel);
    const reason = readText(cancel?.reason);

    if (!reason) {
      continue;
    }

    const trigger = readText(cancel?.trigger);
    const started = readProfileRef(cancel?.started);
    const next = readProfileRef(cancel?.next);

    return {
      t: event.t,
      mono: event.mono,
      reason,
      ...(trigger ? { trigger } : {}),
      ...(started ? { started } : {}),
      ...(next ? { next } : {})
    };
  }

  return null;
}

/**
 * The `meta.config.captureFallback` record (untrusted archive data, read defensively): when and
 * why the recording left Full. Null for archives that never fell back.
 */
export function readCaptureFallback(
  events: readonly WebBlackboxEvent[]
): CaptureFallbackInfo | null {
  for (const event of events) {
    if (event.type !== "meta.config") {
      continue;
    }

    const fallback = asRecord(asRecord(event.data)?.captureFallback);
    const reason = readText(fallback?.reason);

    if (!fallback || !reason) {
      continue;
    }

    const at =
      typeof fallback.at === "number" && Number.isFinite(fallback.at) ? fallback.at : event.t;
    const detail = readText(fallback.detail);

    return {
      at,
      mono: event.mono,
      reason,
      from: readText(fallback.from) ?? "full",
      to: readText(fallback.to) ?? "lite",
      ...(detail ? { detail } : {})
    };
  }

  return null;
}

function readProfileRef(value: unknown): { id: string; name: string } | undefined {
  const record = asRecord(value);
  const id = readText(record?.id);
  const name = readText(record?.name);
  return id && name ? { id, name } : undefined;
}

function readTextList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.slice(0, MAX_CAPPED_CATEGORIES).flatMap((entry) => {
        const text = readText(entry);
        return text ? [text] : [];
      })
    : [];
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, MAX_TEXT) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
