import { describe, expect, it } from "vitest";

import { translateExtensionMessage, type ExtensionMessageKey } from "../shared/i18n.js";
import type { ProfileCancelReason } from "../shared/messages.js";
import { describeProfileCancel } from "./profile-picker.js";

const t = (key: ExtensionMessageKey, vars?: Record<string, string | number>): string =>
  translateExtensionMessage("en", key, vars);

describe("describeProfileCancel", () => {
  const cases: Array<[ProfileCancelReason, { summary: string; fix: string }]> = [
    [
      "rule-changed",
      {
        summary: "It recorded with QA, but the site rules pick Default for this page.",
        fix: "To keep recording here with QA, choose it in the profile list instead of Auto, or add a site rule for this site in Options → Profiles."
      }
    ],
    [
      "profile-missing",
      {
        summary: "The profile QA was deleted while recording.",
        fix: "Choose another profile, or create or restore one in Options → Profiles, then start again."
      }
    ],
    [
      "profile-edited",
      {
        summary: "The profile QA was changed while recording.",
        fix: "Start a new recording to record with the new settings."
      }
    ],
    [
      "enterprise-policy",
      {
        summary: "Your organization's policy changed what QA may record.",
        fix: "Start a new recording. Ask your administrator if you need more data."
      }
    ]
  ];

  it.each(cases)("explains %s and how to fix it", (reason, expected) => {
    expect(
      describeProfileCancel({ reason, at: 1, startedName: "QA", nextName: "Default" }, t)
    ).toEqual(expected);
  });

  it("does not break when the next profile is unknown", () => {
    expect(
      describeProfileCancel({ reason: "rule-changed", at: 1, startedName: "QA" }, t).summary
    ).toBe("It recorded with QA, but the site rules pick another profile for this page.");
  });
});
