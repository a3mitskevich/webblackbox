import { useEffect, useMemo } from "react";

import { useI18n } from "../../context.js";
import { useFeatureI18n } from "../messages.js";
import { useFeatureSlice, useFeatureSliceUpdate } from "../slice.js";
import { bodyCopyText, maskBody, type BodyContent } from "./body.js";
import { CodeView } from "./code-view.js";
import { CopyButton } from "./copy-button.js";
import { networkMessages } from "./messages.js";
import { networkSlice, type BodyView } from "./slice.js";
import { HexView, JsonTree } from "./viewers.js";

type BodyViewerProps = {
  content: BodyContent;
  /** `data-testid` of the body area (`response-body`, `request-body`). */
  testId: string;
};

function viewsOf(content: BodyContent): BodyView[] {
  if (content.kind === "json") {
    return ["tree", "raw"];
  }

  return content.kind === "binary" ? ["hex"] : ["raw"];
}

function ImagePreview({ bytes, mime }: { bytes: Uint8Array; mime: string }) {
  // Created while rendering, so a new image never shows the previous (already revoked) URL;
  // revoked when the image changes or unmounts. (Not StrictMode-safe: the player has none.)
  const url = useMemo(
    () => URL.createObjectURL(new Blob([bytes.slice()], { type: mime })),
    [bytes, mime]
  );

  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  return <img className="nbody-image" src={url} alt="" data-testid="body-image" />;
}

/**
 * One body: JSON as a tree (default) or highlighted text, other text highlighted, images
 * previewed, binary as a hex dump. "Mask secrets" (on by default, like the classic preview) hides
 * token, password and email values before anything is shown or copied.
 */
export function BodyViewer({ content, testId }: BodyViewerProps) {
  const t = useFeatureI18n(networkMessages);
  const i18n = useI18n();
  const bodyView = useFeatureSlice(networkSlice, (slice) => slice.bodyView);
  const maskSecrets = useFeatureSlice(networkSlice, (slice) => slice.maskSecrets);
  const updateSlice = useFeatureSliceUpdate(networkSlice);
  const shown = useMemo(() => (maskSecrets ? maskBody(content) : content), [content, maskSecrets]);
  const views = viewsOf(shown);
  const view = views.includes(bodyView) ? bodyView : (views[0] as BodyView);
  const canMask = content.kind === "json" || content.kind === "text";
  const canCopy = shown.kind === "json" || shown.kind === "text";
  // The pretty-printed JSON only when the raw view shows it (the copy text is built on click).
  const rawJson = useMemo(
    () => (shown.kind === "json" && view === "raw" ? JSON.stringify(shown.value, null, 2) : null),
    [shown, view]
  );

  if (shown.kind === "empty") {
    return (
      <p className="nbody-note" data-testid={testId}>
        {t("bodyNone")}
      </p>
    );
  }

  return (
    <div className="nbody-viewer" data-testid={testId} data-view={view}>
      <div className="nviewer-tools">
        {views.length > 1 ? (
          <div className="seg seg-small" role="group" aria-label={t("bodyViewLabel")}>
            {views.map((name) => (
              <button
                key={name}
                type="button"
                aria-pressed={name === view}
                onClick={() => updateSlice((slice) => ({ ...slice, bodyView: name }))}
                data-testid={`body-view-${name}`}
              >
                {t(`view_${name}`)}
              </button>
            ))}
          </div>
        ) : null}
        {shown.kind === "image" || shown.kind === "binary" ? (
          <span className="muted">
            {t(shown.kind === "image" ? "imageBody" : "binaryBody", {
              mime: shown.mime,
              size: i18n.formatByteSize(shown.bytes.byteLength)
            })}
          </span>
        ) : null}
        <span className="grow" />
        {canMask ? (
          <label className="ncheck">
            <input
              type="checkbox"
              checked={maskSecrets}
              onChange={(event) => {
                const checked = event.target.checked;
                updateSlice((slice) => ({ ...slice, maskSecrets: checked }));
              }}
              data-testid="mask-secrets"
            />
            {t("maskSecrets")}
          </label>
        ) : null}
        {canCopy ? (
          <CopyButton
            label={t("copyBody")}
            getText={() => bodyCopyText(shown)}
            testId={`${testId}-copy`}
          />
        ) : null}
      </div>
      {shown.kind === "image" ? <ImagePreview bytes={shown.bytes} mime={shown.mime} /> : null}
      {shown.kind === "binary" ? <HexView bytes={shown.bytes} testId={`${testId}-hex`} /> : null}
      {shown.kind === "json" && view === "tree" ? (
        <JsonTree value={shown.value} testId={`${testId}-tree`} />
      ) : null}
      {rawJson !== null ? (
        <CodeView text={rawJson} language="json" testId={`${testId}-raw`} />
      ) : null}
      {shown.kind === "text" ? (
        <CodeView text={shown.text} language={shown.language} testId={`${testId}-raw`} />
      ) : null}
    </div>
  );
}
