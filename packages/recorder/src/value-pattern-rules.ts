import {
  maskPointerLabels,
  maskValuePatterns,
  type RedactionRules,
  type RedactionTarget,
  type WebBlackboxEventType
} from "@webblackbox/protocol";

/**
 * The user's value patterns for an event's recorded strings. Bodies and URLs are masked where
 * they are recorded (body policy, URL recording); the raw DOM and action labels in the page,
 * with action labels masked here again in case a stale page script did not.
 */
export function applyValuePatterns(
  eventType: WebBlackboxEventType,
  payload: unknown,
  rules: RedactionRules
): unknown {
  if (!rules?.valuePatterns?.length) {
    return payload;
  }

  const target = targetOf(eventType);

  if (!target) {
    return maskPointerLabels(eventType, payload, rules);
  }

  return mapStrings(payload, (text) => maskValuePatterns(text, rules, target));
}

function targetOf(eventType: WebBlackboxEventType): RedactionTarget | null {
  if (eventType === "console.entry" || eventType.startsWith("error.")) {
    return "console";
  }

  if (eventType === "user.input") {
    return "inputs";
  }

  return eventType.startsWith("storage.") ? "storage" : null;
}

function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === "string") {
    return map(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => mapStrings(item, map));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapStrings(item, map)])
    );
  }

  return value;
}
