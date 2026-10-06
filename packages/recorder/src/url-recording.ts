import {
  isContentRedactionEnabled,
  maskValuePatterns,
  recordUrl,
  redactCredentials,
  usesBuiltInHeuristics,
  type RedactionRules
} from "@webblackbox/protocol";

/** The rules of the event being normalized (normalization is synchronous). */
let activeRules: RedactionRules;

/**
 * Runs `normalize` with `rules` deciding how URLs are recorded: the single switch point for every
 * URL the normalizers write. Outside it, URLs get the default (masked) treatment.
 */
export function withUrlRules<T>(rules: RedactionRules, normalize: () => T): T {
  const previous = activeRules;
  activeRules = rules;

  try {
    return normalize();
  } finally {
    activeRules = previous;
  }
}

/** A URL as the current rules record it (as-is, sanitized, or with user rules masked). */
export function recordedUrl(url: string): string {
  return recordUrl(url, activeRules);
}

/**
 * Visible page text (a tab title) as the current rules record it: the user's `dom` value patterns,
 * plus credential-shaped runs when the built-in heuristics are on; as-is with masking off.
 */
export function recordedPageText(text: string): string {
  if (!isContentRedactionEnabled(activeRules)) {
    return text;
  }

  const masked = maskValuePatterns(text, activeRules, "dom");
  return usesBuiltInHeuristics(activeRules) ? redactCredentials(masked) : masked;
}
