import { Popover } from "@base-ui/react/popover";
import type { SymbolicatedFrame } from "@webblackbox/player-sdk";
import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { ArrowRightLeft, Code, Copy, FolderOpen, Link2, Unlink } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type CSSProperties
} from "react";

import { formatOffset } from "../../../core/format.js";
import { copyText } from "../../../lib/export.js";
import { useController, usePlayerState } from "../../context.js";
import type { LoadedArchive } from "../../state.js";
import { useFeatureI18n } from "../messages.js";
import { useFeatureSlice, useFeatureSliceUpdate } from "../slice.js";
import {
  describeLocation,
  findRelatedRequestId,
  pickStackEvent,
  shortPath,
  type ConsoleRow
} from "./console-model.js";
import { highlightLines, languageOf, type HighlightToken } from "./highlight.js";
import { consoleMessages, type ConsoleTranslate } from "./messages.js";
import { consoleSlice, type StackMode } from "./slice.js";
import {
  getSymbolicationService,
  toSourceMapFiles,
  type StackResolution,
  type SymbolicationService
} from "./symbolication.js";

type Translate = ConsoleTranslate;

const ICON_PROPS = { size: 14, strokeWidth: 1.5, absoluteStrokeWidth: true, "aria-hidden": true };
const LIBRARY_PATH = /(^|\/)node_modules\//u;

function useStackResolution(
  service: SymbolicationService,
  event: WebBlackboxEvent
): StackResolution | undefined {
  const version = useSyncExternalStore(service.subscribe, service.version, service.version);

  useEffect(() => {
    service.request(event);
  }, [service, event, version]);

  return service.peek(event.id);
}

/** Map sources: `.map` files, a folder of maps, a symbol server URL (remembered). */
function MapSourcesButton({ service, t }: { service: SymbolicationService; t: Translate }) {
  const sources = useSyncExternalStore(service.subscribe, service.sources, service.sources);
  const [server, setServer] = useState(sources.symbolServer);
  const filesId = useId();
  const folderId = useId();
  const folderProps = { webkitdirectory: "", directory: "" } as Record<string, string>;

  const onFiles = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    service.addMapFiles(toSourceMapFiles(files));
  };

  return (
    <Popover.Root>
      <Popover.Trigger className="btn small" data-testid="console-map-sources">
        <FolderOpen {...ICON_PROPS} />
        {t("mapSources")}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="end" className="cpop-layer">
          <Popover.Popup className="cpop" data-testid="console-map-sources-popup">
            <Popover.Title className="cpop-title">{t("mapSourcesTitle")}</Popover.Title>
            <p className="cpop-note">{t("mapSourcesHint")}</p>
            <div className="cpop-row">
              <input
                id={filesId}
                className="file-input"
                type="file"
                multiple
                accept=".map,.json,application/json"
                onChange={onFiles}
                data-testid="console-map-files"
              />
              <label className="btn small" htmlFor={filesId}>
                {t("loadMapFiles")}
              </label>
              <input
                id={folderId}
                className="file-input"
                type="file"
                multiple
                onChange={onFiles}
                {...folderProps}
              />
              <label className="btn small" htmlFor={folderId}>
                {t("loadMapFolder")}
              </label>
            </div>
            {sources.mapFileCount > 0 ? (
              <p className="cpop-note" data-testid="console-map-count">
                {t("mapsLoaded", { count: sources.mapFileCount })}
              </p>
            ) : null}
            <form
              className="cpop-row"
              onSubmit={(event) => {
                event.preventDefault();
                service.setSymbolServer(server);
              }}
            >
              <label className="field">
                <span className="visually-hidden">{t("symbolServer")}</span>
                <input
                  type="url"
                  value={server}
                  placeholder={t("symbolServerPlaceholder")}
                  onChange={(event) => setServer(event.target.value)}
                  data-testid="console-symbol-server"
                />
              </label>
              <button type="submit" className="btn small">
                {t("apply")}
              </button>
            </form>
            {sources.symbolServerInvalid ? (
              <p className="cpop-note bad">{t("symbolServerInvalid")}</p>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

const MAP_SOURCE_KEYS = {
  archive: "mapSourceArchive",
  files: "mapSourceFiles",
  "symbol-server": "mapSourceServer"
} as const;

function describeMapSource(frames: readonly SymbolicatedFrame[], t: Translate): string | null {
  const mapped = frames.find((frame) => frame.status === "mapped");

  if (!mapped) {
    return null;
  }

  const key = MAP_SOURCE_KEYS[mapped.mapSource as keyof typeof MAP_SOURCE_KEYS];
  return key ? t(key) : (mapped.mapSource ?? t("mapSourceArchive"));
}

/** The frame's function name; `anonymous` is what an unnamed one reads as (V8 text when copied). */
function frameName(frame: SymbolicatedFrame, mode: StackMode, anonymous = "(anonymous)"): string {
  const original = mode === "original" ? frame.original?.functionName : undefined;
  return original ?? frame.frame.functionName ?? anonymous;
}

function FrameRow({
  frame,
  mode,
  isTop
}: {
  frame: SymbolicatedFrame;
  mode: StackMode;
  isTop: boolean;
}) {
  const minified = describeLocation(frame.frame.url, frame.frame.line, frame.frame.column);
  const original = mode === "original" && frame.status === "mapped" ? frame.original : undefined;
  const location = original
    ? describeLocation(original.source, original.line, original.column)
    : minified;
  const isLibrary = LIBRARY_PATH.test(original?.source ?? frame.frame.url);
  const classes = ["sframe", isTop ? "cur" : "", isLibrary ? "lib" : ""].filter(Boolean).join(" ");
  const t = useFeatureI18n(consoleMessages);

  return (
    <li className={classes} data-testid="stack-frame" data-status={frame.status}>
      <span className="fn">{frameName(frame, mode, t("anonymousFunction"))}</span>
      <span className="loc" title={original ? original.source : frame.frame.url}>
        {location}
      </span>
      {original ? <span className="min">{shortPath(minified)}</span> : null}
    </li>
  );
}

function tokenStyle(token: HighlightToken): CSSProperties | undefined {
  if (!token.color && !token.darkColor) {
    return undefined;
  }

  return { color: token.color, "--hl-dark": token.darkColor } as CSSProperties;
}

/** Source lines around the original position; highlighted once Shiki's chunk has loaded. */
function SourceSnippet({ frame }: { frame: SymbolicatedFrame }) {
  const snippet = frame.snippet;
  const source = frame.original?.source ?? "";
  const [tokens, setTokens] = useState<HighlightToken[][] | null>(null);

  useEffect(() => {
    const language = languageOf(source);
    let isCurrent = true;
    setTokens(null);

    if (!snippet || !language) {
      return undefined;
    }

    highlightLines(snippet.lines.join("\n"), language).then(
      (lines) => {
        if (isCurrent) {
          setTokens(lines);
        }
      },
      () => undefined
    );

    return () => {
      isCurrent = false;
    };
  }, [snippet, source]);

  if (!snippet) {
    return null;
  }

  return (
    <pre className="snippet" data-testid="stack-snippet" data-highlighted={tokens !== null}>
      {snippet.lines.map((line, index) => {
        const lineNumber = snippet.startLine + index;
        const lineTokens = tokens?.[index];

        return (
          <span
            key={lineNumber}
            className={lineNumber === snippet.highlightLine ? "ln hit" : "ln"}
            data-hit={lineNumber === snippet.highlightLine || undefined}
          >
            <span className="n">{lineNumber}</span>
            <code>
              {lineTokens
                ? lineTokens.map((token, tokenIndex) => (
                    <span key={tokenIndex} className="hl" style={tokenStyle(token)}>
                      {token.content}
                    </span>
                  ))
                : line}
            </code>
          </span>
        );
      })}
    </pre>
  );
}

function stackText(frames: readonly SymbolicatedFrame[], mode: StackMode): string {
  return frames
    .map((frame) => {
      const original = mode === "original" && frame.status === "mapped" ? frame.original : null;
      const where = original
        ? `${original.source}:${original.line}:${original.column}`
        : `${frame.frame.url}:${frame.frame.line}:${frame.frame.column}`;
      return `    at ${frameName(frame, mode)} (${where})`;
    })
    .join("\n");
}

function StackFrames({
  resolution,
  mode,
  t
}: {
  resolution: StackResolution | undefined;
  mode: StackMode;
  t: Translate;
}) {
  if (!resolution || resolution.status === "pending") {
    return <p className="stack-note">{t("resolving")}</p>;
  }

  if (resolution.status === "error") {
    return <p className="stack-note bad">{t("mapError", { error: resolution.message })}</p>;
  }

  const snippetFrame =
    mode === "original"
      ? resolution.frames.find((frame) => frame.status === "mapped" && frame.snippet)
      : undefined;

  return (
    <>
      <ul className="sframes" data-testid="stack-frames">
        {resolution.frames.map((frame, index) => (
          <FrameRow
            key={`${frame.frame.raw}-${index}`}
            frame={frame}
            mode={mode}
            isTop={index === 0}
          />
        ))}
      </ul>
      {snippetFrame ? <SourceSnippet frame={snippetFrame} /> : null}
    </>
  );
}

type StackBlockProps = {
  archive: LoadedArchive;
  row: ConsoleRow;
  event: WebBlackboxEvent;
  message: string;
};

/**
 * A console row opened in place (Replay mockup "Console"): the stack, Original or Minified, the
 * source around the throwing line, and Copy stack / Open request / Raw event.
 */
export function StackBlock({ archive, row, event, message }: StackBlockProps) {
  const controller = useController();
  const t = useFeatureI18n(consoleMessages);
  const locale = usePlayerState((state) => state.locale);
  const mode = useFeatureSlice(consoleSlice, (slice) => slice.stackMode);
  const updateSlice = useFeatureSliceUpdate(consoleSlice);
  const [showRaw, setShowRaw] = useState(false);
  const service = getSymbolicationService(archive.player);
  // Similar rows may differ in detail (an exception's one frame, the logged error's full stack).
  const stackEvent = useMemo(() => pickStackEvent(archive, row) ?? event, [archive, row, event]);
  const resolution = useStackResolution(service, stackEvent);
  const { entry } = row;
  const frames = resolution?.status === "done" ? resolution.frames : [];
  const mapSource = describeMapSource(frames, t);
  const requestId = findRelatedRequestId(archive, entry);
  const request = requestId ? archive.model.waterfallByReqId.get(requestId) : undefined;
  const lastMember = row.memberIds.at(-1);
  const lastMono = lastMember ? archive.model.eventById.get(lastMember)?.mono : undefined;

  const copyStack = async (): Promise<void> => {
    const text = [message, stackText(frames, mode)].filter(Boolean).join("\n");
    const announcement = await copyText(text).then(
      () => t("stackCopied"),
      () => t("copyFailed")
    );
    controller.store.setState((state) => ({ ...state, announcement }));
  };

  return (
    <div className="exc" data-testid="console-details">
      {entry.hasStack ? (
        <div className="exc-h">
          {mapSource ? (
            <span className="mapok" data-testid="stack-status">
              <Link2 {...ICON_PROPS} />
              {t("symbolicated", { source: mapSource })}
            </span>
          ) : (
            <span className="mapno" data-testid="stack-status">
              <Unlink {...ICON_PROPS} />
              {resolution?.status === "done" ? t("notSymbolicated") : t("resolving")}
            </span>
          )}
          <span className="hdr-spacer" />
          <MapSourcesButton service={service} t={t} />
          <div className="seg seg-small" role="group" aria-label={t("stackView")}>
            {(["original", "minified"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={mode === option}
                onClick={() => updateSlice((slice) => ({ ...slice, stackMode: option }))}
                data-testid={`stack-mode-${option}`}
              >
                {t(option === "original" ? "original" : "minified")}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {message.length > 160 || !entry.hasStack ? (
        <pre className="exc-msg" data-testid="console-message">
          {message}
        </pre>
      ) : null}
      {entry.hasStack ? <StackFrames resolution={resolution} mode={mode} t={t} /> : null}
      {row.count > 1 && lastMono !== undefined ? (
        <p className="stack-note" data-testid="console-group-span">
          {t("similarSpan", {
            count: row.count,
            first: formatOffset(entry.mono - archive.model.minMono, locale),
            last: formatOffset(lastMono - archive.model.minMono, locale)
          })}
        </p>
      ) : null}
      <div className="exc-f">
        {entry.hasStack ? (
          <button
            type="button"
            className="btn small"
            onClick={() => void copyStack()}
            data-testid="copy-stack"
          >
            <Copy {...ICON_PROPS} />
            {t("copyStack")}
          </button>
        ) : null}
        {request ? (
          <button
            type="button"
            className="btn small"
            onClick={() => {
              controller.select({ kind: "request", id: request.reqId });
              controller.setTab("network");
            }}
            data-testid="open-request"
          >
            <ArrowRightLeft {...ICON_PROPS} />
            {t("openRequest", {
              id: request.reqId,
              status: request.status ?? (request.failed ? t("failed") : "—")
            })}
          </button>
        ) : entry.reqId ? (
          <span className="stack-note" data-testid="request-not-recorded">
            {t("requestNotRecorded", { id: entry.reqId })}
          </span>
        ) : null}
        <button
          type="button"
          className="btn small"
          aria-pressed={showRaw}
          onClick={() => setShowRaw((value) => !value)}
          data-testid="raw-event"
        >
          <Code {...ICON_PROPS} />
          {t("rawEvent")}
        </button>
      </div>
      {showRaw ? (
        <pre className="code exc-raw" data-testid="raw-event-json">
          {JSON.stringify(event, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}
