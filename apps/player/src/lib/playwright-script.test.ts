import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import { generatePlaywrightScriptFromEvents } from "./playwright-script.js";

function event(
  id: string,
  mono: number,
  type: WebBlackboxEvent["type"],
  data: WebBlackboxEvent["data"]
): WebBlackboxEvent {
  return {
    v: 1,
    sid: "S-test",
    tab: 1,
    t: mono,
    mono,
    type,
    id,
    data
  };
}

describe("generatePlaywrightScriptFromEvents", () => {
  it("generates Playwright actions from already filtered playback events", () => {
    const script = generatePlaywrightScriptFromEvents(
      [
        event("E-1", 100, "user.click", {
          target: {
            selector: "button.save"
          }
        }),
        event("E-2", 200, "user.input", {
          target: {
            selector: "input[name=email]"
          },
          value: "dev@example.test"
        })
      ],
      {
        startUrl: "https://example.test",
        includeHarReplay: false
      }
    );

    expect(script).toContain('await page.goto("https://example.test");');
    expect(script).toContain("HAR replay disabled");
    expect(script).toContain('await page.click("button.save");');
    expect(script).toContain('await page.fill("input[name=email]", "dev@example.test");');
  });

  it("keeps archive-controlled values from escaping the generated script", () => {
    const script = generatePlaywrightScriptFromEvents(
      [
        event("E-1", 100, "user.input", {
          target: {
            selector: "#email\u2028process.exit(1)"
          },
          value: "[MASKED]"
        })
      ],
      {
        name: "it's a test",
        includeHarReplay: false
      }
    );

    expect(script).toContain('test("it\'s a test", async ({ browser }) => {');
    expect(script).toContain("  // input on #email process.exit(1) was masked in capture");
    expect(script).not.toMatch(/[\n\u2028]process\.exit/);
  });

  it("respects maxActions after the caller applies the playback-time range", () => {
    const script = generatePlaywrightScriptFromEvents(
      [
        event("E-1", 1_700_000_000_100, "user.click", {
          target: {
            selector: "button.first"
          }
        }),
        event("E-2", 1_700_000_000_200, "user.click", {
          target: {
            selector: "button.second"
          }
        })
      ],
      {
        maxActions: 1
      }
    );

    expect(script).toContain("button.first");
    expect(script).not.toContain("button.second");
  });
});
