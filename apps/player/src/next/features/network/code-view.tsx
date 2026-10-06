import { useEffect, useMemo, useState } from "react";

import { VirtualList } from "../../components/virtual-list.js";
import { useI18n } from "../../context.js";
import { useFeatureI18n } from "../messages.js";
import type { CodeToken, HighlightLanguage } from "./highlight.js";
import { networkMessages } from "./messages.js";

/** Highlighted on its own up to this size (LIBRARIES.md: Shiki is slow on big payloads). */
export const MAX_AUTO_HIGHLIGHT_CHARS = 64 * 1024;
/** "Highlight" on demand up to this size; above it the text stays plain. */
const MAX_HIGHLIGHT_CHARS = 512 * 1024;
const LINE_HEIGHT = 19;

type CodeViewProps = {
  text: string;
  language: "plain" | HighlightLanguage;
  testId?: string;
  /** A short block (a message, a curl command) grows with its content instead of scrolling. */
  inline?: boolean;
};

function useHighlight(
  text: string,
  language: "plain" | HighlightLanguage,
  enabled: boolean
): CodeToken[][] | null {
  const [state, setState] = useState<{
    text: string;
    language: string;
    lines: CodeToken[][];
  } | null>(null);

  useEffect(() => {
    if (!enabled || language === "plain") {
      return;
    }

    let cancelled = false;

    // The highlighter and its grammars load as their own chunk on first use.
    import("./highlight.js")
      .then(({ highlightLines }) => {
        if (!cancelled) {
          setState({ text, language, lines: highlightLines(text, language as HighlightLanguage) });
        }
      })
      .catch(() => {
        // Highlighting is an enhancement: the plain text stays on screen.
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, language, text]);

  return state && state.text === text && state.language === language ? state.lines : null;
}

function LineContent({ tokens, text }: { tokens: CodeToken[] | undefined; text: string }) {
  if (!tokens || tokens.length === 0) {
    return <>{text.length > 0 ? text : " "}</>;
  }

  return (
    <>
      {tokens.map((token, index) => (
        <span key={index} className="ntok" style={token.style}>
          {token.content}
        </span>
      ))}
    </>
  );
}

/**
 * Text with line numbers: virtualized, highlighted by Shiki (both themes as CSS variables) when the
 * text is small enough, plain with a "Highlight" button when it is large.
 */
export function CodeView({ text, language, testId, inline = false }: CodeViewProps) {
  const t = useFeatureI18n(networkMessages);
  const i18n = useI18n();
  // "Highlight anyway" belongs to the text it was asked for: a new body starts plain again.
  const [forcedText, setForcedText] = useState<string | null>(null);
  const forced = forcedText === text;
  const lines = useMemo(() => text.split("\n"), [text]);
  const isLarge = text.length > MAX_AUTO_HIGHLIGHT_CHARS;
  const canHighlight = language !== "plain" && text.length <= MAX_HIGHLIGHT_CHARS;
  const highlighted = useHighlight(text, language, canHighlight && (!isLarge || forced));
  const gutter = String(lines.length).length + 1;

  const renderLine = (index: number) => (
    <div key={index} className="ncode-line">
      <span className="nln" style={{ width: `${gutter}ch` }} aria-hidden="true">
        {index + 1}
      </span>
      <span className="nlc">
        <LineContent tokens={highlighted?.[index]} text={lines[index] ?? ""} />
      </span>
    </div>
  );

  return (
    <div
      className={inline ? "ncode-view ninline" : "ncode-view"}
      data-testid={testId}
      data-highlighted={highlighted !== null}
    >
      {isLarge && canHighlight && !forced ? (
        <p className="ncode-note">
          {t("largePlain", { size: i18n.formatByteSize(text.length) })}{" "}
          <button type="button" className="btn small" onClick={() => setForcedText(text)}>
            {t("highlightAnyway")}
          </button>
        </p>
      ) : null}
      {inline ? (
        <div className="ncode">{lines.map((_, index) => renderLine(index))}</div>
      ) : (
        <VirtualList
          className="ncode"
          role="region"
          tabIndex={0}
          aria-label={t("codeLabel")}
          itemCount={lines.length}
          rowHeight={LINE_HEIGHT}
          renderRow={renderLine}
        />
      )}
    </div>
  );
}
