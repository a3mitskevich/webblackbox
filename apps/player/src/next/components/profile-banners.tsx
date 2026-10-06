import { useMemo } from "react";

import { useController, useI18n, usePlayerState } from "../context.js";
import { Icon } from "./icon.js";
import { profileBannerLines } from "./recording-profile.js";

/**
 * The recording profile warnings (downgraded, capped by policy, recording cut short) above the
 * stage, with a way to the full "About this recording". Nothing for a recording that kept
 * everything its profile asks for.
 */
export function ProfileBanners() {
  const controller = useController();
  const i18n = useI18n();
  const archive = usePlayerState((state) => state.archive);
  const lines = useMemo(() => (archive ? profileBannerLines(archive, i18n) : []), [archive, i18n]);

  if (lines.length === 0) {
    return null;
  }

  return (
    <section
      className="profile-banners"
      aria-label={i18n.tn("profileBannersLabel")}
      data-testid="profile-banners"
    >
      {lines.map((line) => (
        <p key={line} className="profile-banner" data-testid="profile-banner">
          <Icon name="flag" />
          <span>{line}</span>
        </p>
      ))}
      <button
        type="button"
        className="btn small"
        onClick={() => controller.setArchiveInfoOpen(true)}
        data-testid="profile-banner-details"
      >
        {i18n.tn("profileDetails")}
      </button>
    </section>
  );
}
