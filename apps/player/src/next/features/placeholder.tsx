import type { ComponentType } from "react";

import type { RailTab } from "../../core/url-hash.js";
import type { PlayerLocale } from "../../lib/i18n.js";
import { useI18n, usePlayerState } from "../context.js";

/**
 * The panel of a rail tab whose feature has not landed yet: names the panel and points to the
 * classic player. The owning stage replaces it in its feature folder.
 */
export function placeholderPanel(
  tab: RailTab,
  label: (locale: PlayerLocale) => string
): ComponentType {
  function ComingLater() {
    const i18n = useI18n();
    const locale = usePlayerState((state) => state.locale);

    return (
      <div className="coming" data-testid={`panel-placeholder-${tab}`}>
        <p>{i18n.tn("comingLater", { panel: label(locale) })}</p>
        <p className="muted">{i18n.tn("comingLaterHint")}</p>
      </div>
    );
  }

  ComingLater.displayName = `ComingLater(${tab})`;
  return ComingLater;
}
