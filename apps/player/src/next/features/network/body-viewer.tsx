import { useEffect, useMemo, useState } from "react";

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
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const objectUrl = URL.createObjectURL(new Blob([bytes.slice()], { type: mime }));
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [bytes, mime]);

  return url ? <img className="nbody-image" src={url} alt="" data-testid="body-image" /> : null;
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
  const copyText = bodyCopyText(shown);

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
        {copyText !== null ? (
          <CopyButton label={t("copyBody")} getText={() => copyText} testId={`${testId}-copy`} />
        ) : null}
      </div>
      {shown.kind === "image" ? <ImagePreview bytes={shown.bytes} mime={shown.mime} /> : null}
      {shown.kind === "binary" ? <HexView bytes={shown.bytes} testId={`${testId}-hex`} /> : null}
      {shown.kind === "json" && view === "tree" ? (
        <JsonTree key={shown.text} value={shown.value} testId={`${testId}-tree`} />
      ) : null}
      {shown.kind === "json" && view === "raw" ? (
        <CodeView
          text={JSON.stringify(shown.value, null, 2)}
          language="json"
          testId={`${testId}-raw`}
        />
      ) : null}
      {shown.kind === "text" ? (
        <CodeView text={shown.text} language={shown.language} testId={`${testId}-raw`} />
      ) : null}
    </div>
  );
}
