import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import {
  describePrivacyViolation,
  readProfileCancellation,
  readRecordingProfiles
} from "./recording-profile.js";

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

describe("readRecordingProfiles — enterprise caps", () => {
  it("keeps the categories the enterprise policy capped, as strings only", () => {
    const [entry] = readRecordingProfiles([
      event("meta.config", {
        profile: {
          id: "builtin:full-capture",
          name: "Full capture",
          enterpriseCapped: ["console", 7, "network", "x".repeat(500)]
        }
      })
    ]);

    expect(entry?.enterpriseCapped).toEqual(["console", "network", "x".repeat(200)]);
  });
});

describe("readProfileCancellation", () => {
  it("reads why a recording was stopped after its profile changed", () => {
    const events = [
      event("meta.config", { profile: { id: "builtin:qa", name: "QA" } }, 1),
      event(
        "meta.config",
        {
          profile: { id: "builtin:qa", name: "QA" },
          profileCancel: {
            reason: "rule-changed",
            trigger: "navigation",
            at: 1_700_000_000_000,
            started: { id: "builtin:qa", name: "QA", ruleName: "Stage" },
            next: { id: "default", name: "Default" }
          }
        },
        9
      )
    ];

    expect(readProfileCancellation(events)).toEqual({
      t: 9,
      mono: 9,
      reason: "rule-changed",
      trigger: "navigation",
      started: { id: "builtin:qa", name: "QA" },
      next: { id: "default", name: "Default" }
    });
  });

  it("returns null for archives without a cancellation and tolerates junk", () => {
    expect(readProfileCancellation([event("meta.config", { profile: { id: "a" } })])).toBeNull();
    expect(
      readProfileCancellation([event("meta.config", { profileCancel: { reason: 5 } })])
    ).toBeNull();
    expect(
      readProfileCancellation([
        event("meta.config", { profileCancel: { reason: "rule-changed", started: "junk" } })
      ])
    ).toEqual({ t: 1, mono: 1, reason: "rule-changed" });
  });
});
