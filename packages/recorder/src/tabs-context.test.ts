import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  validateEvent,
  type RecorderConfig,
  type RedactionProfile,
  type TabsContextLevel,
  type WebBlackboxEvent
} from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import { WebBlackboxRecorder } from "./recorder.js";

const TAB = {
  tabId: 41,
  windowId: 2,
  relation: "same-origin",
  origin: "https://app.example.com",
  path: "/orders/8f14e45fceea167a5a36dedd4bea2543?token=PATHSECRET",
  title: "Orders eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXZhbHVlLXRlc3Q acct-555",
  active: true,
  focused: false,
  incognito: false,
  discarded: false,
  firstSeenAt: 1_700_000_000_000,
  lastAccessed: 1_699_999_999_000
};

function recorder(
  tabsContext: TabsContextLevel | undefined,
  redaction: Partial<RedactionProfile> = {}
): WebBlackboxRecorder {
  const categories = { ...DEFAULT_CAPTURE_POLICY.categories, tabsContext };
  const config: RecorderConfig = {
    ...DEFAULT_RECORDER_CONFIG,
    redaction: { ...DEFAULT_RECORDER_CONFIG.redaction, ...redaction },
    capturePolicy: { ...DEFAULT_CAPTURE_POLICY, categories }
  };

  return new WebBlackboxRecorder(config);
}

function ingest(
  target: WebBlackboxRecorder,
  rawType: "tabs.snapshot" | "tabs.change",
  payload: unknown
): WebBlackboxEvent | undefined {
  return target.ingest({ source: "system", rawType, sid: "S-1", tabId: 7, t: 1, mono: 1, payload })
    .event;
}

function snapshot(level: "metadata" | "allow", tabs: unknown[] = [TAB]) {
  return { reason: "start", level, origin: "https://app.example.com", site: "example.com", tabs };
}

describe("parallel tabs context events", () => {
  it("records a metadata snapshot", () => {
    const metadataTab = { ...TAB, path: undefined, title: undefined };
    const event = ingest(
      recorder("metadata"),
      "tabs.snapshot",
      snapshot("metadata", [metadataTab])
    );

    expect(event?.type).toBe("meta.tabs.snapshot");
    expect(event?.privacy).toEqual({ category: "system", sensitivity: "low", redacted: true });
    expect(event?.data).toEqual({
      reason: "start",
      level: "metadata",
      origin: "https://app.example.com",
      site: "example.com",
      tabs: [
        {
          tabId: 41,
          windowId: 2,
          relation: "same-origin",
          origin: "https://app.example.com",
          active: true,
          focused: false,
          incognito: false,
          discarded: false,
          firstSeenAt: 1_700_000_000_000,
          lastAccessed: 1_699_999_999_000
        }
      ]
    });
    expect(validateEvent(event).success).toBe(true);
  });

  it("treats policies without the category as the metadata level", () => {
    const event = ingest(recorder(undefined), "tabs.snapshot", snapshot("metadata", []));

    expect(event?.type).toBe("meta.tabs.snapshot");
  });

  it("blocks tab events when the category is off", () => {
    const event = ingest(recorder("off"), "tabs.change", {
      change: "opened",
      level: "metadata",
      tab: { ...TAB, path: undefined, title: undefined },
      openCount: 1
    });

    expect(event?.type).toBe("privacy.violation");
    expect(event?.data).toMatchObject({
      blockedType: "meta.tabs.change",
      reason: "tabs-context-disabled"
    });
  });

  it("blocks paths and titles on a metadata session", () => {
    const event = ingest(recorder("metadata"), "tabs.snapshot", snapshot("allow"));

    expect(event?.type).toBe("privacy.violation");
    expect(event?.data).toMatchObject({ reason: "tabs-context-detail-disabled" });
    expect(JSON.stringify(event)).not.toContain("PATHSECRET");
  });

  it("masks paths and titles at the allow level with masking on", () => {
    const event = ingest(
      recorder("allow", { valuePatterns: [{ pattern: "acct-\\d+", targets: ["dom"] }] }),
      "tabs.change",
      { change: "navigated", level: "allow", tab: TAB, openCount: 2 }
    );
    const tab = (event?.data as { tab: { path: string; title: string } }).tab;

    expect(event?.type).toBe("meta.tabs.change");
    expect(event?.privacy?.redacted).toBe(false);
    expect(tab.path).toBe("/orders/:id");
    expect(tab.title).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(tab.title).not.toContain("acct-555");
    expect(tab.title.startsWith("Orders")).toBe(true);
    expect(validateEvent(event).success).toBe(true);
  });

  it("records paths and titles as captured with masking off", () => {
    const event = ingest(recorder("allow", { contentRedaction: false }), "tabs.change", {
      change: "entered",
      level: "allow",
      tab: TAB,
      openCount: 1
    });
    const tab = (event?.data as { tab: { path: string; title: string } }).tab;

    expect(tab.path).toBe(TAB.path);
    expect(tab.title).toBe(TAB.title);
  });

  it("drops malformed payloads", () => {
    const target = recorder("allow");

    expect(ingest(target, "tabs.snapshot", { level: "allow", tabs: [] })).toBeUndefined();
    expect(
      ingest(target, "tabs.change", { change: "teleported", level: "allow", tab: TAB })
    ).toBeUndefined();
    expect(
      ingest(target, "tabs.change", { change: "closed", level: "allow", tab: { tabId: -1 } })
    ).toBeUndefined();

    expect(
      ingest(target, "tabs.snapshot", snapshot("allow", [TAB, { tabId: "x" }]))
    ).toBeUndefined();
    expect(
      ingest(target, "tabs.snapshot", snapshot("allow", [{ ...TAB, url: "https://x.test/" }]))
    ).toBeUndefined();
  });
});
