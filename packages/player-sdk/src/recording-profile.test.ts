import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import { describePrivacyViolation, readRecordingProfiles } from "./recording-profile.js";

function event(type: WebBlackboxEvent["type"], data: unknown, t = 1): WebBlackboxEvent {
  return { v: 1, sid: "S", tab: 1, t, mono: t, type, id: `E-${t}`, data };
}

describe("describePrivacyViolation", () => {
  it("maps recorder reasons to what the profile hid", () => {
    expect(
      describePrivacyViolation(
        event("privacy.violation", {
          blockedType: "console.entry",
          reason: "console-payload-disabled"
        })
      )
    ).toEqual({
      blockedType: "console.entry",
      reason: "console-payload-disabled",
      subject: "console-text"
    });
    expect(
      describePrivacyViolation(event("privacy.violation", { reason: "network-body-disabled" }))
        ?.subject
    ).toBe("network-body");
  });

  it("tolerates unknown or malformed payloads", () => {
    expect(describePrivacyViolation(event("privacy.violation", "junk"))).toEqual({
      subject: "unknown"
    });
    expect(describePrivacyViolation(event("console.entry", {}))).toBeNull();
    expect(
      describePrivacyViolation(event("privacy.violation", { reason: "toString" }))?.subject
    ).toBe("unknown");
  });
});

describe("readRecordingProfiles", () => {
  it("lists profile periods from meta.config events", () => {
    const entries = readRecordingProfiles([
      event("meta.config", { mode: "full" }, 1),
      event(
        "meta.config",
        {
          profile: {
            id: "builtin:qa",
            name: "QA",
            source: "rule",
            ruleId: "r",
            ruleName: "Stage",
            extended: true
          }
        },
        2
      ),
      event("meta.config", { profile: { id: "builtin:qa", name: "QA", ruleId: "r" } }, 3),
      event(
        "meta.config",
        {
          profile: {
            id: "builtin:full",
            name: "Full",
            source: "explicit",
            extended: false,
            downgradedFrom: {
              id: "builtin:full-capture",
              name: "Full capture",
              reason: "host-not-allowed"
            }
          }
        },
        4
      ),
      event("meta.config", { profile: { id: 5, name: null } }, 5)
    ]);

    expect(entries).toEqual([
      {
        t: 2,
        mono: 2,
        id: "builtin:qa",
        name: "QA",
        source: "rule",
        ruleId: "r",
        ruleName: "Stage",
        extended: true
      },
      {
        t: 4,
        mono: 4,
        id: "builtin:full",
        name: "Full",
        source: "explicit",
        extended: false,
        downgradedFrom: {
          id: "builtin:full-capture",
          name: "Full capture",
          reason: "host-not-allowed"
        }
      }
    ]);
  });
});
