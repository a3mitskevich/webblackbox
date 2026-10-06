import { describe, expect, it } from "vitest";

import {
  capturePolicySchema,
  DEFAULT_CAPTURE_POLICY,
  validateEvent,
  WEBBLACKBOX_PROTOCOL_VERSION
} from "./index.js";

const relatedTab = {
  tabId: 41,
  windowId: 3,
  relation: "same-site",
  origin: "https://admin.example.com",
  active: false,
  focused: false,
  incognito: false,
  firstSeenAt: 1_700_000_000_000
};

function envelope(type: string, data: unknown) {
  return {
    v: WEBBLACKBOX_PROTOCOL_VERSION,
    sid: "S-1",
    tab: 7,
    t: 1_700_000_000_500,
    mono: 12,
    type,
    id: "E-1",
    data
  };
}

describe("parallel tabs context", () => {
  it("accepts a tabs snapshot with metadata and allow-level tabs", () => {
    const result = validateEvent(
      envelope("meta.tabs.snapshot", {
        reason: "start",
        level: "allow",
        origin: "https://app.example.com",
        site: "example.com",
        tabs: [
          relatedTab,
          {
            ...relatedTab,
            tabId: 42,
            relation: "same-origin",
            origin: "https://app.example.com",
            path: "/orders/:id",
            title: "Orders",
            discarded: true,
            frozen: false,
            openerTabId: 7,
            lastAccessed: 1_699_999_999_000
          }
        ]
      })
    );

    expect(result.success).toBe(true);
  });

  it("accepts a tabs change and rejects unknown kinds or fields", () => {
    const change = { change: "closed", level: "metadata", tab: relatedTab, openCount: 0 };

    expect(validateEvent(envelope("meta.tabs.change", change)).success).toBe(true);
    expect(
      validateEvent(envelope("meta.tabs.change", { ...change, change: "moved" })).success
    ).toBe(false);
    expect(
      validateEvent(
        envelope("meta.tabs.change", { ...change, tab: { ...relatedTab, url: "https://x.test/" } })
      ).success
    ).toBe(false);
    expect(validateEvent(envelope("meta.tabs.change", { ...change, level: "off" })).success).toBe(
      false
    );
  });

  it("defaults the tabsContext category to metadata and keeps older policies valid", () => {
    const { tabsContext, ...legacyCategories } = DEFAULT_CAPTURE_POLICY.categories;

    expect(tabsContext).toBe("metadata");
    expect(
      capturePolicySchema.safeParse({ ...DEFAULT_CAPTURE_POLICY, categories: legacyCategories })
        .success
    ).toBe(true);
    expect(
      capturePolicySchema.safeParse({
        ...DEFAULT_CAPTURE_POLICY,
        categories: { ...legacyCategories, tabsContext: "everything" }
      }).success
    ).toBe(false);
  });
});
