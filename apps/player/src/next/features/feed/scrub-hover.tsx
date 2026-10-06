import { PreviewCard } from "@base-ui/react/preview-card";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { resolveShotForMono } from "../../../core/stage-media.js";
import { lowerBoundByMono, upperBoundByMono } from "../../../lib/range.js";
import { compactText } from "../../../lib/text.js";
import { Icon } from "../../components/icon.js";
import { useController, useI18n, usePlayerState } from "../../context.js";
import type { LoadedArchive } from "../../state.js";
import { describeContext, describeFeedItem, feedDataOf } from "./feed-view.js";

/** Items within this share of the session around the pointer are listed on the card. */
const NEAR_SHARE = 0.02;
const MAX_TAGS = 4;
const TAG_TEXT_MAX = 44;
/** The card stays this long after the pointer leaves, so it can be reached and clicked. */
const CLOSE_DELAY_MS = 220;

type HoverPoint = { mono: number; x: number; y: number };

function routeAt(archive: LoadedArchive, mono: number): string {
  const chapter = [...archive.view.chapters].reverse().find((entry) => entry.startMono <= mono);
  return chapter?.label ?? "";
}

/** The screenshot at or before `mono` as an object URL (the media cache keeps it). */
function useThumbnail(archive: LoadedArchive, mono: number): string | null {
  const controller = useController();
  const shotId = resolveShotForMono(archive.model.screenshots, mono)?.shotId ?? null;
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!shotId) {
      setUrl(null);
      return;
    }

    void controller.loadScreenshotUrl(shotId).then(
      (loaded) => {
        if (!cancelled) {
          setUrl(loaded);
        }
      },
      () => {
        if (!cancelled) {
          setUrl(null);
        }
      }
    );

    return () => {
      cancelled = true;
    };
  }, [controller, shotId]);

  return url;
}

type CardBodyProps = { archive: LoadedArchive; mono: number };

function CardBody({ archive, mono }: CardBodyProps) {
  const controller = useController();
  const i18n = useI18n();
  const locale = usePlayerState((state) => state.locale);
  const thumbnail = useThumbnail(archive, mono);
  const context = useMemo(() => describeContext(archive, locale), [archive, locale]);
  const near = useMemo(() => {
    const reach = archive.model.durationMono * NEAR_SHARE;
    const curated = feedDataOf(archive).curated;
    const pickMono = (item: (typeof curated)[number]) => item.mono;
    // Curated items are in time order: only the window around the pointer is looked at.
    return curated
      .slice(
        lowerBoundByMono(curated, mono - reach, pickMono),
        upperBoundByMono(curated, mono + reach, pickMono)
      )
      .filter((item) => !item.thirdParty)
      .sort((left, right) => Math.abs(left.mono - mono) - Math.abs(right.mono - mono))
      .slice(0, MAX_TAGS)
      .sort((left, right) => left.mono - right.mono);
  }, [archive, mono]);

  return (
    <>
      <div className="hover-head">
        <span className="mono">{i18n.formatSeconds(mono - archive.model.minMono)}</span>
        <span className="mono hover-route">{routeAt(archive, mono)}</span>
      </div>
      {thumbnail ? <img className="hover-thumb" src={thumbnail} alt="" /> : null}
      {near.length > 0 ? (
        <ul className="hover-tags">
          {near.map((item) => {
            const row = describeFeedItem(item, context);
            const label = compactText(
              [row.code, row.lead, row.subject].filter(Boolean).join(" "),
              TAG_TEXT_MAX
            );

            return (
              <li key={item.eventId}>
                <button
                  type="button"
                  className={`hover-tag tone-${row.tone}`}
                  onClick={() => {
                    const event = archive.model.eventById.get(item.eventId);

                    if (event) {
                      controller.selectEvent(event);
                    }
                  }}
                  data-testid="scrub-hover-tag"
                >
                  <Icon name={row.glyph} />
                  <span>{label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
}

export type ScrubHover = {
  /** The pointer moved over the scrub surface, at `mono` (not while scrubbing). */
  onMove: (mono: number, clientX: number, top: number) => void;
  /** The pointer left the surface or started scrubbing. */
  onLeave: () => void;
  card: ReactNode;
};

/**
 * The timeline hover card (classic `showProgressHover`, PARITY "Hover card"): time, route, the
 * screenshot at that moment and the nearby feed items as tags that select them. A Base UI
 * `PreviewCard` anchored to the pointer above the lanes; it stays open while the pointer is on it.
 */
export function useScrubHover(archive: LoadedArchive | null): ScrubHover {
  const [point, setPoint] = useState<HoverPoint | null>(null);
  const closeTimer = useRef<number | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const onLeave = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setPoint(null), CLOSE_DELAY_MS);
  }, [cancelClose]);
  const onMove = useCallback(
    (mono: number, x: number, y: number) => {
      cancelClose();
      setPoint({ mono, x, y });
    },
    [cancelClose]
  );

  useEffect(() => cancelClose, [cancelClose]);

  const anchor = useMemo(
    () => (point ? { getBoundingClientRect: () => new DOMRect(point.x, point.y, 0, 0) } : null),
    [point]
  );

  const card =
    archive && point && anchor ? (
      <PreviewCard.Root open onOpenChange={(open) => (open ? undefined : setPoint(null))}>
        <PreviewCard.Portal>
          <PreviewCard.Positioner
            className="hover-layer"
            anchor={anchor}
            side="top"
            sideOffset={10}
            collisionPadding={8}
          >
            <PreviewCard.Popup
              className="hover-card"
              onPointerEnter={cancelClose}
              onPointerLeave={onLeave}
              data-testid="scrub-hover"
            >
              <CardBody archive={archive} mono={point.mono} />
            </PreviewCard.Popup>
          </PreviewCard.Positioner>
        </PreviewCard.Portal>
      </PreviewCard.Root>
    ) : null;

  return { onMove, onLeave, card };
}
