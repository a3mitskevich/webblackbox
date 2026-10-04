/**
 * The user's redaction rules, as every capture stage applies them (zod-free: page scripts load
 * this). Masking is best effort and does not guarantee that all sensitive data is removed; what
 * is captured at all is decided by the capture policy categories.
 *
 * Each stage asks one question here instead of reading profile fields itself:
 * {@link isContentRedactionEnabled} (master switch), {@link usesBuiltInHeuristics} (the built-in
 * rule set), and the rule helpers below.
 */
import {
  BODY_REDACTION_TOKEN,
  isTextualMimeType,
  redactBodyBytes,
  redactBodyText,
  type BodyBytesRedactionResult,
  type BodyTextRedactionResult
} from "./body-redaction.js";
import { compileLinearRegex, type LinearRegex } from "./linear-regex.js";
import { sanitizeUrlForPrivacy } from "./privacy.js";
import type { RedactionProfile, RedactionTarget, RedactionValuePattern } from "./types.js";

/** Replacement written for masked values. */
export const REDACTED_VALUE = "[REDACTED]";

export const REDACTION_TARGETS: readonly RedactionTarget[] = [
  "bodies",
  "dom",
  "storage",
  "inputs",
  "console",
  "urls"
];

/** Any redaction profile shape, or none (masking then follows the defaults). */
export type RedactionRules = Partial<RedactionProfile> | null | undefined;

const compiledPatterns = new WeakMap<
  readonly RedactionValuePattern[],
  Map<string, LinearRegex[]>
>();

/** Master switch: false means captured content is recorded as-is. */
export function isContentRedactionEnabled(rules: RedactionRules): boolean {
  return rules?.contentRedaction !== false;
}

/** The built-in heuristic rule set (URL stripping, secret detection, fail-closed DOM sanitizing). */
export function usesBuiltInHeuristics(rules: RedactionRules): boolean {
  return isContentRedactionEnabled(rules) && rules?.builtInHeuristics !== false;
}

/** JSON/form body key patterns to mask, or none when masking is off. */
export function bodyKeyPatterns(rules: RedactionRules): readonly string[] {
  return isContentRedactionEnabled(rules) ? (rules?.redactBodyPatterns ?? []) : [];
}

/** A captured body as recorded: key rules, then value patterns (as-is when masking is off). */
export function maskBodyText(
  text: string,
  rules: RedactionRules,
  redactionToken: string = BODY_REDACTION_TOKEN
): BodyTextRedactionResult {
  if (!isContentRedactionEnabled(rules)) {
    return { value: text, redacted: false };
  }

  const keyed = redactBodyText(text, bodyKeyPatterns(rules), redactionToken);
  const value = maskValuePatterns(keyed.value, rules, "bodies");
  return { value, redacted: keyed.redacted || value !== keyed.value };
}

/** {@link maskBodyText} for body bytes; value patterns only read textual MIME types. */
export function maskBodyBytes(
  bytes: Uint8Array,
  rules: RedactionRules,
  options: { mimeType?: string; redactionToken?: string } = {}
): BodyBytesRedactionResult {
  if (!isContentRedactionEnabled(rules)) {
    return { bytes, redacted: false };
  }

  const keyed = redactBodyBytes(bytes, bodyKeyPatterns(rules), options);
  const hasBodyPatterns = rules?.valuePatterns?.some((rule) => rule.targets.includes("bodies"));

  if (!hasBodyPatterns || !isTextualMimeType(options.mimeType ?? "")) {
    return keyed;
  }

  const text = new TextDecoder().decode(keyed.bytes);
  const masked = maskValuePatterns(text, rules, "bodies");
  return masked === text ? keyed : { bytes: new TextEncoder().encode(masked), redacted: true };
}

/** Whether `name` contains any non-empty entry (case-insensitive). */
export function matchesRuleName(name: string, entries: readonly string[] | undefined): boolean {
  const lowered = name.toLowerCase();
  return (entries ?? []).some((entry) => entry.length > 0 && lowered.includes(entry.toLowerCase()));
}

/** Whether a storage value is masked by the user's storage key rules. */
export function isMaskedStorageKey(key: string, rules: RedactionRules): boolean {
  return isContentRedactionEnabled(rules) && matchesRuleName(key, rules?.redactStorageKeys);
}

/** `text` with the user's value patterns for `target` masked (as-is when masking is off). */
export function maskValuePatterns(
  text: string,
  rules: RedactionRules,
  target: RedactionTarget
): string {
  if (!isContentRedactionEnabled(rules) || !rules?.valuePatterns?.length || text.length === 0) {
    return text;
  }

  return patternsFor(rules.valuePatterns, target).reduce(
    (current, regex) => regex.replaceAll(current, REDACTED_VALUE),
    text
  );
}

/**
 * A URL as recorded: as-is when masking is off; through the built-in sanitizer (query and
 * fragment stripped, ids templated) when its heuristics are on; otherwise with the user's query
 * parameters and URL value patterns masked.
 */
export function recordUrl(url: string, rules: RedactionRules): string {
  if (!isContentRedactionEnabled(rules)) {
    return url;
  }

  if (usesBuiltInHeuristics(rules)) {
    return sanitizeUrlForPrivacy(url);
  }

  return maskValuePatterns(maskQueryParams(url, rules?.redactQueryParams ?? []), rules, "urls");
}

/** `url` with the values of the named query (and fragment) parameters masked. */
export function maskQueryParams(url: string, names: readonly string[]): string {
  const wanted = new Set(names.filter((name) => name.length > 0).map((name) => name.toLowerCase()));

  if (wanted.size === 0) {
    return url;
  }

  return url.replace(/([?&#;])([^=&#;]+)=([^&#;]*)/g, (pair, separator: string, name: string) =>
    wanted.has(safeDecode(name).toLowerCase()) ? `${separator}${name}=${REDACTED_VALUE}` : pair
  );
}

function patternsFor(
  rules: readonly RedactionValuePattern[],
  target: RedactionTarget
): LinearRegex[] {
  let byTarget = compiledPatterns.get(rules);

  if (!byTarget) {
    byTarget = new Map();
    compiledPatterns.set(rules, byTarget);
  }

  let compiled = byTarget.get(target);

  if (!compiled) {
    // Invalid patterns never reach here through the schema; any that do are skipped.
    compiled = rules
      .filter((rule) => rule.targets.includes(target))
      .map((rule) => compileLinearRegex(rule.pattern))
      .filter((regex): regex is LinearRegex => regex !== null);
    byTarget.set(target, compiled);
  }

  return compiled;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
