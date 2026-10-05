import type { NetworkWaterfallEntry, WebBlackboxPlayer } from "@webblackbox/player-sdk";
import { diffLines } from "diff";
import microdiff from "microdiff";
import { useEffect, useMemo, useState } from "react";

import { useFeatureI18n } from "../messages.js";
import { compareMessages } from "./messages.js";

/** Each side is diffed up to this many characters (the rest is noted, not shown). */
export const MAX_DIFF_CHARS = 256 * 1024;
/** Unchanged runs longer than this fold to their first and last `CONTEXT_LINES`. */
const FOLD_MIN_LINES = 8;
const CONTEXT_LINES = 3;

export type DiffLine =
  | { kind: "same" | "add" | "del"; text: string; left?: number; right?: number }
  | { kind: "fold"; count: number };

export type HeaderChange = {
  name: string;
  kind: "added" | "removed" | "changed";
  left?: string;
  right?: string;
};

/** The response body as text: JSON pretty-printed, `null` when the archive kept none. */
export async function loadResponseText(
  player: WebBlackboxPlayer,
  entry: NetworkWaterfallEntry | undefined
): Promise<string | null> {
  if (!entry?.responseBodyHash) {
    return null;
  }

  const blob = await player.getBlob(entry.responseBodyHash);

  if (!blob) {
    return null;
  }

  const text = new TextDecoder("utf-8").decode(blob.bytes);

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

/** Line diff of two texts with long unchanged runs folded. */
export function buildDiffLines(left: string, right: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let leftLine = 1;
  let rightLine = 1;

  for (const change of diffLines(left, right)) {
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
  left: { player: WebBlackboxPlayer; entry: NetworkWaterfallEntry | undefined };
  right: { player: WebBlackboxPlayer; entry: NetworkWaterfallEntry | undefined };
};

type Bodies =
  | { status: "loading" }
  | { status: "ready"; left: string | null; right: string | null };

/** Response headers and body of one endpoint in A and B, as a unified diff. */
export function BodyDiff({ left, right }: BodyDiffProps) {
  const t = useFeatureI18n(compareMessages);
  const [bodies, setBodies] = useState<Bodies>({ status: "loading" });

  useEffect(() => {
    let isCurrent = true;
    setBodies({ status: "loading" });

    Promise.all([
      loadResponseText(left.player, left.entry),
      loadResponseText(right.player, right.entry)
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
  const lines = useMemo(() => {
    if (bodies.status !== "ready" || bodies.left === null || bodies.right === null) {
      return null;
    }

    return buildDiffLines(
      bodies.left.slice(0, MAX_DIFF_CHARS),
      bodies.right.slice(0, MAX_DIFF_CHARS)
    );
  }, [bodies]);
  const isCut =
    bodies.status === "ready" &&
    ((bodies.left?.length ?? 0) > MAX_DIFF_CHARS || (bodies.right?.length ?? 0) > MAX_DIFF_CHARS);

  return (
    <div className="cmp-diff" data-testid="compare-diff">
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
      {bodies.status === "ready" && lines === null ? (
        <p className="muted" data-testid="compare-body-missing">
          {bodies.left === null && bodies.right === null
            ? t("bodyMissingBoth")
            : bodies.left === null
              ? t("bodyMissingA")
              : t("bodyMissingB")}
        </p>
      ) : null}
      {lines && lines.every((line) => line.kind === "same" || line.kind === "fold") ? (
        <p className="muted" data-testid="compare-body-same">
          {t("bodySame")}
        </p>
      ) : null}
      {lines && lines.some((line) => line.kind === "add" || line.kind === "del") ? (
        <pre className="cmp-lines" data-testid="compare-body-diff">
          {lines.map((line, index) =>
            line.kind === "fold" ? (
              <span key={index} className="dl fold">
                {t("unchangedLines", { count: line.count })}
              </span>
            ) : (
              <span key={index} className={`dl ${line.kind}`} data-kind={line.kind}>
                <span className="n">{line.left ?? ""}</span>
                <span className="n">{line.right ?? ""}</span>
                <span className="sign">
                  {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                </span>
                <code>{line.text}</code>
              </span>
            )
          )}
        </pre>
      ) : null}
      {isCut ? <p className="muted">{t("bodyCut", { limit: "256 KB" })}</p> : null}
    </div>
  );
}
