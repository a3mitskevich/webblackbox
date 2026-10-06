import { diffWordsWithSpace, type Change } from "diff";
import microdiff from "microdiff";
import { useMemo } from "react";

import { useI18n } from "../../context.js";
import { useFeatureI18n } from "../messages.js";
import { storageMessages } from "./messages.js";

/** The differing middle of two values is word-diffed up to this many characters per side. */
export const MAX_DIFF_WINDOW_CHARS = 32 * 1024;
/** Unchanged text shown around the differing middle. */
const CONTEXT_CHARS = 80;
/** A common prefix/suffix is moved to a word boundary at most this far (else cut mid-word). */
const WORD_BOUNDARY_LOOKBACK = 64;
/** Values larger than this skip JSON.parse + microdiff and go to the bounded word diff. */
export const MAX_JSON_DIFF_CHARS = 256 * 1024;
/** One before/after value of a field change is shown up to this many characters. */
export const MAX_FIELD_VALUE_CHARS = 2_000;
const MAX_FIELD_CHANGES = 200;
const ELLIPSIS = "…";

const WORD_CHAR = /[\p{L}\p{N}_]/u;

export type FieldChange = {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: string;
  after?: string;
};

/** A word diff of only the part of two values that differs, with a little context around it. */
export type WordDiffWindow = {
  /** Unchanged text just before the differing part. */
  prefix: string;
  /** More unchanged text precedes `prefix` (shown as "…"). */
  isPrefixElided: boolean;
  parts: Change[];
  /** The differing part was longer than the window: the rest is not compared. */
  isLimited: boolean;
  /** Unchanged text just after the differing part. */
  suffix: string;
  /** More unchanged text follows `suffix` (shown as "…"). */
  isSuffixElided: boolean;
};

function capText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}${ELLIPSIS}` : text;
}

function isHighSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

/** The first `count` UTF-16 units of `text`, never ending inside a surrogate pair. */
function headOf(text: string, count: number): string {
  const end = Math.min(count, text.length);
  return text.slice(
    0,
    end > 0 && end < text.length && isHighSurrogate(text, end - 1) ? end - 1 : end
  );
}

/** The last `count` UTF-16 units of `text`, never starting inside a surrogate pair. */
function tailOf(text: string, count: number): string {
  const start = Math.max(0, text.length - count);
  return text.slice(start > 0 && isLowSurrogate(text, start) ? start + 1 : start);
}

function commonPrefixLength(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  let length = 0;

  while (length < max && left.charCodeAt(length) === right.charCodeAt(length)) {
    length += 1;
  }

  // "😀" and "😁" share their high surrogate: keep the pair whole in the differing part.
  return length > 0 && isHighSurrogate(left, length - 1) ? length - 1 : length;
}

function commonSuffixLength(left: string, right: string, prefix: number): number {
  const max = Math.min(left.length, right.length) - prefix;
  let length = 0;

  while (
    length < max &&
    left.charCodeAt(left.length - 1 - length) === right.charCodeAt(right.length - 1 - length)
  ) {
    length += 1;
  }

  return length > 0 && isLowSurrogate(left, left.length - length) ? length - 1 : length;
}

function isWordChar(text: string, index: number): boolean {
  return index >= 0 && index < text.length && WORD_CHAR.test(text.charAt(index));
}

/** Shortens a common prefix that ends mid-word to the start of that word (whole words in the diff). */
function snapPrefix(before: string, after: string, length: number): number {
  const isMidWord =
    isWordChar(before, length - 1) && (isWordChar(before, length) || isWordChar(after, length));
  const floor = Math.max(0, length - WORD_BOUNDARY_LOOKBACK);
  let snapped = length;

  while (isMidWord && snapped > floor && isWordChar(before, snapped - 1)) {
    snapped -= 1;
  }

  return snapped;
}

/** Shortens a common suffix that starts mid-word to the end of that word. */
function snapSuffix(before: string, after: string, length: number): number {
  const beforeCut = before.length - length;
  const afterCut = after.length - length;
  const isMidWord =
    isWordChar(before, beforeCut) &&
    (isWordChar(before, beforeCut - 1) || isWordChar(after, afterCut - 1));
  const floor = Math.max(0, length - WORD_BOUNDARY_LOOKBACK);
  let snapped = length;

  while (isMidWord && snapped > floor && isWordChar(before, before.length - snapped)) {
    snapped -= 1;
  }

  return snapped;
}

/**
 * Word diff of the differing middle of two values: the common prefix and suffix are trimmed
 * first, so a change anywhere in a long value is found; the middle is capped per side.
 */
export function diffWordWindow(before: string, after: string): WordDiffWindow {
  const prefixLength = snapPrefix(before, after, commonPrefixLength(before, after));
  const suffixLength = snapSuffix(before, after, commonSuffixLength(before, after, prefixLength));
  const middleBefore = before.slice(prefixLength, before.length - suffixLength);
  const middleAfter = after.slice(prefixLength, after.length - suffixLength);
  const isLimited =
    middleBefore.length > MAX_DIFF_WINDOW_CHARS || middleAfter.length > MAX_DIFF_WINDOW_CHARS;
  const commonPrefix = before.slice(0, prefixLength);
  const commonSuffix = before.slice(before.length - suffixLength);

  return {
    prefix: tailOf(commonPrefix, CONTEXT_CHARS),
    isPrefixElided: commonPrefix.length > CONTEXT_CHARS,
    parts: diffWordsWithSpace(
      headOf(middleBefore, MAX_DIFF_WINDOW_CHARS),
      headOf(middleAfter, MAX_DIFF_WINDOW_CHARS)
    ),
    isLimited,
    suffix: headOf(commonSuffix, CONTEXT_CHARS),
    isSuffixElided: commonSuffix.length > CONTEXT_CHARS
  };
}

/**
 * Field-level changes when both values are JSON objects or arrays, else `null` (also for values
 * over {@link MAX_JSON_DIFF_CHARS}). Each shown value is capped at {@link MAX_FIELD_VALUE_CHARS}.
 */
export function diffJsonValues(before: string, after: string): FieldChange[] | null {
  if (before.length > MAX_JSON_DIFF_CHARS || after.length > MAX_JSON_DIFF_CHARS) {
    return null;
  }

  const parse = (text: string): object | null => {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === "object" && value !== null ? value : null;
    } catch {
      return null;
    }
  };
  const left = parse(before);
  const right = parse(after);

  if (!left || !right) {
    return null;
  }

  const show = (value: unknown): string =>
    capText(JSON.stringify(value) ?? String(value), MAX_FIELD_VALUE_CHARS);

  return microdiff(left as Record<string, unknown>, right as Record<string, unknown>)
    .slice(0, MAX_FIELD_CHANGES)
    .map((change): FieldChange => {
      const path = change.path.join(".");

      if (change.type === "CREATE") {
        return { path, kind: "added", after: show(change.value) };
      }

      if (change.type === "REMOVE") {
        return { path, kind: "removed", before: show(change.oldValue) };
      }

      return { path, kind: "changed", before: show(change.oldValue), after: show(change.value) };
    });
}

function WordDiff({ diff }: { diff: WordDiffWindow }) {
  const t = useFeatureI18n(storageMessages);
  const i18n = useI18n();

  return (
    <>
      {diff.isLimited ? (
        <p className="muted" data-testid="storage-diff-limited">
          {t("diffLimited", { count: i18n.formatNumber(MAX_DIFF_WINDOW_CHARS) })}
        </p>
      ) : null}
      <pre className="st-value" data-testid="storage-word-diff">
        {diff.isPrefixElided ? <span className="elided">{ELLIPSIS}</span> : null}
        {diff.prefix}
        {diff.parts.map((part, index) => (
          <span key={index} className={part.added ? "ins" : part.removed ? "del" : undefined}>
            {part.value}
          </span>
        ))}
        {diff.isLimited ? <span className="elided">{ELLIPSIS}</span> : null}
        {diff.suffix}
        {diff.isSuffixElided ? <span className="elided">{ELLIPSIS}</span> : null}
      </pre>
    </>
  );
}

type ValueDiffProps = {
  before: string | null | undefined;
  after: string | undefined;
};

/**
 * The value before and after a write: JSON field changes (microdiff), else a word diff (jsdiff).
 * `before === null` means the key did not exist; `undefined` that the archive cannot tell.
 */
export function ValueDiff({ before, after }: ValueDiffProps) {
  const t = useFeatureI18n(storageMessages);
  const fields = useMemo(
    () =>
      typeof before === "string" && after !== undefined ? diffJsonValues(before, after) : null,
    [before, after]
  );
  const words = useMemo(
    () =>
      typeof before === "string" && after !== undefined && before !== after && !fields
        ? diffWordWindow(before, after)
        : null,
    [before, after, fields]
  );

  if (after === undefined) {
    return <p className="muted">{t("valueNotKept")}</p>;
  }

  if (before === undefined) {
    return (
      <>
        <p className="muted">{t("previousUnknown")}</p>
        <pre className="st-value">{after}</pre>
      </>
    );
  }

  if (before === null) {
    return (
      <>
        <p className="muted">{t("newKey")}</p>
        <pre className="st-value">{after}</pre>
      </>
    );
  }

  if (before === after) {
    return <p className="muted">{t("valueUnchanged")}</p>;
  }

  if (fields) {
    return (
      <ul className="st-fields" data-testid="storage-field-changes">
        {fields.map((field) => (
          <li key={field.path} className={`fd fd-${field.kind}`}>
            <span className="mono path">{field.path || t("rootValue")}</span>
            <span className="mono">
              {field.kind === "added"
                ? `+ ${field.after ?? ""}`
                : field.kind === "removed"
                  ? `− ${field.before ?? ""}`
                  : `${field.before ?? ""} → ${field.after ?? ""}`}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  return words ? <WordDiff diff={words} /> : null;
}
