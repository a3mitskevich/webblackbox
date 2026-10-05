import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import { createPlayerI18n } from "./i18n.js";
import {
  formatPrivacyViolationText,
  formatRecordingProfileBanner,
  formatRecordingProfileSummary,
  isConsolePrivacyViolation
} from "./recording-profile-view.js";

const i18n = createPlayerI18n("en");

function violation(blockedType: string, reason: string): WebBlackboxEvent {
  return {
    v: 1,
    sid: "S",
    tab: 1,
    t: 1,
    mono: 1,
    type: "privacy.violation",
    id: "E-1",
    data: { blockedType, reason, redacted: true }
  };
}

describe("recording profile view", () => {
  it("labels console text hidden by the profile", () => {
    const event = violation("console.entry", "console-payload-disabled");

    expect(isConsolePrivacyViolation(event)).toBe(true);
    expect(formatPrivacyViolationText(event, i18n.formatHiddenByProfile)).toBe(
      "Hidden by profile: console text"
    );
    expect(isConsolePrivacyViolation(violation("network.body", "network-body-disabled"))).toBe(
      false
    );
  });

  it("summarizes profile periods", () => {
    expect(formatRecordingProfileSummary([], i18n)).toBeNull();
    expect(
      formatRecordingProfileSummary(
        [
          { t: 1, mono: 1, id: "default", name: "Default", extended: false },
          { t: 2, mono: 2, id: "builtin:qa", name: "QA", ruleName: "Stage", extended: true },
          {
            t: 3,
            mono: 3,
            id: "builtin:full",
            name: "Full",
            extended: false,
            downgradedFrom: { id: "builtin:full-capture", name: "Full capture" }
          }
        ],
        i18n
      )
    ).toBe(
      "profile Default → profile QA (rule Stage) → profile Full (Full capture not allowed on this site)"
    );
  });

  it("warns when the recording was stopped because its profile changed", () => {
    const entries = [{ t: 1, mono: 1, id: "builtin:qa", name: "QA", extended: true }];

    expect(formatRecordingProfileBanner(entries, null, i18n)).toEqual([]);
    expect(
      formatRecordingProfileBanner(
        entries,
        {
          t: 9,
          mono: 9,
          reason: "rule-changed",
          started: { id: "builtin:qa", name: "QA" },
          next: { id: "default", name: "Default" }
        },
        i18n
      )
    ).toEqual([
      "Recording stopped early: it recorded with QA, but after a navigation the site rules picked Default. Nothing after that point was recorded."
    ]);
    expect(
      formatRecordingProfileBanner(entries, { t: 9, mono: 9, reason: "something-new" }, i18n)
    ).toEqual(["Recording stopped early: the recording profile changed (something-new)."]);
  });

  it("warns about old downgraded archives and enterprise caps", () => {
    expect(
      formatRecordingProfileBanner(
        [
          {
            t: 1,
            mono: 1,
            id: "builtin:full",
            name: "Full",
            extended: false,
            downgradedFrom: { id: "builtin:full-capture", name: "Full capture" }
          },
          {
            t: 2,
            mono: 2,
            id: "builtin:qa",
            name: "QA",
            extended: true,
            enterpriseCapped: ["console", "network"]
          }
        ],
        null,
        i18n
      )
    ).toEqual([
      "Recorded with Full instead of Full capture: Full capture was not allowed on this site, so data only Full capture records is missing.",
      "The organization's policy limited QA: console, network."
    ]);
  });
});
