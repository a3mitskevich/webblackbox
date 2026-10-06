import type { NetworkWaterfallEntry, WebBlackboxPlayer } from "@webblackbox/player-sdk";
import { diffLines } from "diff";
import microdiff from "microdiff";
import { useEffect, useMemo, useState } from "react";

import { VirtualList } from "../../components/virtual-list.js";
import { useI18n } from "../../context.js";
import { useFeatureI18n } from "../messages.js";
import { compareMessages } from "./messages.js";

/** Each body is diffed up to this many bytes (the rest is noted, not shown). */
export const MAX_DIFF_BYTES = 256 * 1024;
/**
 * The line diff gives up beyond this many changed lines (jsdiff is O(N·D)); the panel then says
 * the bodies are too different instead of freezing.
 */
export const MAX_EDIT_LENGTH = 2000;
/** And after this long, whatever the edit count. */
const DIFF_TIMEOUT_MS = 1000;
/** Unchanged runs longer than this fold to their first and last `CONTEXT_LINES`. */
const FOLD_MIN_LINES = 8;
const CONTEXT_LINES = 3;
/** Fixed row height of the virtualized diff (matches `.cmp-lines .dl` in compare.css). */
const DIFF_ROW_HEIGHT = 19;

export type DiffLine =
  | { kind: "same" | "add" | "del"; text: string; left?: number; right?: number }
  | { kind: "fold"; count: number };

export type HeaderChange = {
  name: string;
  kind: "added" | "removed" | "changed";
  left?: string;
  right?: string;
};

/** A response body as text; `isCut` when only its first `MAX_DIFF_BYTES` were decoded. */
export type ResponseBody = { text: string; isCut: boolean };

/** The response body (at most `MAX_DIFF_BYTES` of it), `null` when the archive kept none. */
export async function loadResponseBody(
  player: WebBlackboxPlayer,
  entry: NetworkWaterfallEntry | undefined
): Promise<ResponseBody | null> {
  if (!entry?.responseBodyHash) {
    return null;
  }

  const blob = await player.getBlob(entry.responseBodyHash);

  if (!blob) {
    return null;
  }

  const isCut = blob.bytes.byteLength > MAX_DIFF_BYTES;
  // `stream` keeps a multi-byte character split by the cut out of the text.
  const text = new TextDecoder("utf-8").decode(blob.bytes.subarray(0, MAX_DIFF_BYTES), {
    stream: isCut
  });
  return { text, isCut };
}

/** JSON pretty-printed; anything else (a cut JSON too) as it is. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function splitLines(value: string): string[] {
  const lines = value.split("\n");
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

/**
 * Line diff of two texts with long unchanged runs folded; `null` when they differ in more than
 * `maxEditLength` lines (or the diff takes too long).
 */
export function buildDiffLines(
  left: string,
  right: string,
  maxEditLength = MAX_EDIT_LENGTH
): DiffLine[] | null {
  const changes = diffLines(left, right, { maxEditLength, timeout: DIFF_TIMEOUT_MS });

  if (!changes) {
    return null;
  }

  const lines: DiffLine[] = [];
  let leftLine = 1;
  let rightLine = 1;

  for (const change of changes) {
    for (const text of splitLines(change.value)) {
      if (change.added) {
        lines.push({ kind: "add", text, right: rightLine++ });
      } else if (change.removed) {
        lines.push({ kind: "del", text, left: leftLine++ });
      } else {
        lines.push({ kind: "same", text, left: leftLine++, right: rightLine++ });
      }
    }
  }

  return foldUnchanged(lines);
}

function foldUnchanged(lines: readonly DiffLine[]): DiffLine[] {
  const folded: DiffLine[] = [];
  let run: DiffLine[] = [];

  const flush = (isEdge: { start: boolean; end: boolean }): void => {
    const keepStart = isEdge.start ? 0 : CONTEXT_LINES;
    const keepEnd = isEdge.end ? 0 : CONTEXT_LINES;

    if (run.length >= FOLD_MIN_LINES && run.length > keepStart + keepEnd) {
      folded.push(...run.slice(0, keepStart));
      folded.push({ kind: "fold", count: run.length - keepStart - keepEnd });
      folded.push(...run.slice(run.length - keepEnd));
    } else {
      folded.push(...run);
    }

    run = [];
  };

  for (const line of lines) {
    if (line.kind === "same") {
      run.push(line);
      continue;
    }

    flush({ start: folded.length === 0, end: false });
    folded.push(line);
  }

  flush({ start: folded.length === 0, end: true });
  return folded;
}

/** Response header differences (names compared case-insensitively). */
export function diffHeaders(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>
): HeaderChange[] {
  const lower = (headers: Readonly<Record<string, string>>) =>
    Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const a = lower(left);
  const b = lower(right);

  return microdiff(a, b)
    .map((change): HeaderChange => {
      const name = String(change.path[0]);

      if (change.type === "CREATE") {
        return { name, kind: "added", right: b[name] };
      }

      if (change.type === "REMOVE") {
        return { name, kind: "removed", left: a[name] };
      }

      return { name, kind: "changed", left: a[name], right: b[name] };
    })
    .sort((x, y) => x.name.localeCompare(y.name));
}

type BodyDiffProps = {
  /** The region's id (the endpoint buttons' `aria-controls`). */
  id?: string;
  /** What the region shows (the endpoint). */
  label?: string;
  left: { player: WebBlackboxPlayer; entry: NetworkWaterfallEntry | undefined };
  right: { player: WebBlackboxPlayer; entry: NetworkWaterfallEntry | undefined };
};

type Bodies =
  | { status: "loading" }
  | { status: "ready"; left: ResponseBody | null; right: ResponseBody | null };

type BodyComparison =
  | { status: "missing" }
  | { status: "tooDifferent"; isCut: boolean }
  | { status: "diffed"; lines: DiffLine[]; hasChanges: boolean; isCut: boolean };

function compareBodies(left: ResponseBody | null, right: ResponseBody | null): BodyComparison {
  if (!left || !right) {
    return { status: "missing" };
  }

  const isCut = left.isCut || right.isCut;
  // A cut JSON does not parse; both sides stay raw text then so that they still line up.
  const format = isCut ? (text: string) => text : prettyJson;
  const lines = buildDiffLines(format(left.text), format(right.text));

  if (!lines) {
    return { status: "tooDifferent", isCut };
  }

  const hasChanges = lines.some((line) => line.kind === "add" || line.kind === "del");
  return { status: "diffed", lines, hasChanges, isCut };
}

function DiffRow({ line, unchangedLabel }: { line: DiffLine; unchangedLabel: string }) {
  if (line.kind === "fold") {
    return <div className="dl fold">{unchangedLabel}</div>;
  }

  return (
    <div className={`dl ${line.kind}`} data-kind={line.kind}>
      <span className="n">{line.left ?? ""}</span>
      <span className="n">{line.right ?? ""}</span>
      <span className="sign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
      <code>{line.text}</code>
    </div>
  );
}

/** Response headers and body of one endpoint in A and B, as a unified diff. */
export function BodyDiff({ id, label, left, right }: BodyDiffProps) {
  const t = useFeatureI18n(compareMessages);
  const i18n = useI18n();
  const [bodies, setBodies] = useState<Bodies>({ status: "loading" });

  useEffect(() => {
    let isCurrent = true;
    setBodies({ status: "loading" });

    Promise.all([
      loadResponseBody(left.player, left.entry),
      loadResponseBody(right.player, right.entry)
    ]).then(
      ([a, b]) => {
        if (isCurrent) {
          setBodies({ status: "ready", left: a, right: b });
        }
      },
      () => {
        if (isCurrent) {
          setBodies({ status: "ready", left: null, right: null });
        }
      }
    );

    return () => {
      isCurrent = false;
    };
  }, [left.player, left.entry, right.player, right.entry]);

  const headers = useMemo(
    () => diffHeaders(left.entry?.responseHeaders ?? {}, right.entry?.responseHeaders ?? {}),
    [left.entry, right.entry]
  );
  const comparison = useMemo(
    () => (bodies.status === "ready" ? compareBodies(bodies.left, bodies.right) : null),
    [bodies]
  );
  const limit = i18n.formatByteSize(MAX_DIFF_BYTES);
  const isCut = comparison !== null && comparison.status !== "missing" && comparison.isCut;

  return (
    <div className="cmp-diff" id={id} role="region" aria-label={label} data-testid="compare-diff">
      <h4>{t("headersHeading")}</h4>
      {headers.length === 0 ? (
        <p className="muted">{t("headersSame")}</p>
      ) : (
        <ul className="cmp-headers" data-testid="compare-header-changes">
          {headers.map((change) => (
            <li key={change.name} className={`hd hd-${change.kind}`}>
              <span className="mono name">{change.name}</span>
              <span className="mono">
                {change.kind === "added"
                  ? `+ ${change.right ?? ""}`
                  : change.kind === "removed"
                    ? `− ${change.left ?? ""}`
                    : `${change.left ?? ""} → ${change.right ?? ""}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      <h4>{t("bodyHeading")}</h4>
      {bodies.status === "loading" ? <p className="muted">{t("bodyLoading")}</p> : null}
      {bodies.status === "ready" && comparison?.status === "missing" ? (
        <p className="muted" data-testid="compare-body-missing">
          {bodies.left === null && bodies.right === null
            ? t("bodyMissingBoth")
            : bodies.left === null
              ? t("bodyMissingA")
              : t("bodyMissingB")}
        </p>
      ) : null}
      {comparison?.status === "tooDifferent" ? (
        <p className="muted" data-testid="compare-body-too-different">
          {t("bodyTooDifferent")}
        </p>
      ) : null}
      {comparison?.status === "diffed" && !comparison.hasChanges ? (
        <p className="muted" data-testid="compare-body-same">
          {comparison.isCut ? t("bodySameCut", { limit }) : t("bodySame")}
        </p>
      ) : null}
      {comparison?.status === "diffed" && comparison.hasChanges ? (
        <VirtualList
          role="region"
          tabIndex={0}
          aria-label={t("bodyDiffLabel")}
          className="cmp-lines"
          itemCount={comparison.lines.length}
          rowHeight={DIFF_ROW_HEIGHT}
          testId="compare-body-diff"
          renderRow={(index) => {
            const line = comparison.lines[index] as DiffLine;
            return (
              <DiffRow
                key={index}
                line={line}
                unchangedLabel={
                  line.kind === "fold"
                    ? t("unchangedLines", { count: i18n.formatNumber(line.count) })
                    : ""
                }
              />
            );
          }}
        />
      ) : null}
      {isCut && !(comparison?.status === "diffed" && !comparison.hasChanges) ? (
        <p className="muted" data-testid="compare-body-cut">
          {t("bodyCut", { limit })}
        </p>
      ) : null}
    </div>
  );
}
