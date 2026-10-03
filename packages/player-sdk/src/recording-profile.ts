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
  downgradedFrom?: { id: string; name: string; reason?: string };
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
  "heap-profile-disabled": "profile",
  "cdp-profile-disabled": "profile"
};
const MAX_TEXT = 200;

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
        : {})
    });
  }

  return entries;
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, MAX_TEXT) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
