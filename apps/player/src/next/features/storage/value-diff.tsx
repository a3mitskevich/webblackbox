import { diffWordsWithSpace } from "diff";
import microdiff from "microdiff";
import { useMemo } from "react";

import { useFeatureI18n } from "../messages.js";
import { storageMessages } from "./messages.js";

/** Values longer than this are compared as their first part only. */
const MAX_DIFF_CHARS = 32 * 1024;
const MAX_FIELD_CHANGES = 200;

export type FieldChange = {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: string;
  after?: string;
};

/** Field-level changes when both values are JSON objects or arrays, else `null`. */
export function diffJsonValues(before: string, after: string): FieldChange[] | null {
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

  const show = (value: unknown): string => JSON.stringify(value) ?? String(value);

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
      typeof before === "string" && after !== undefined && !fields
        ? diffWordsWithSpace(before.slice(0, MAX_DIFF_CHARS), after.slice(0, MAX_DIFF_CHARS))
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

  return (
    <pre className="st-value" data-testid="storage-word-diff">
      {words?.map((part, index) => (
        <span key={index} className={part.added ? "ins" : part.removed ? "del" : undefined}>
          {part.value}
        </span>
      ))}
    </pre>
  );
}
