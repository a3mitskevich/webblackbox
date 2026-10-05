import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import {
  buildConsoleEntries,
  countConsoleLevels,
  groupConsoleEntries,
  toConsoleEntry
} from "./console-entries.js";

const SITE = "https://app.example.test";
let sequence = 0;

function event(
  type: string,
  mono: number,
  data: unknown,
  extra: Partial<WebBlackboxEvent> = {}
): WebBlackboxEvent {
  sequence += 1;
  return {
    v: 1,
    sid: "S-1",
    tab: 1,
    t: 1_000 + mono,
    mono,
    type: type as WebBlackboxEvent["type"],
    id: `E-${sequence}`,
    data,
    ...extra
  };
}

describe("buildConsoleEntries", () => {
  it("reads level, message, location and the related request of console entries", () => {
    const entries = buildConsoleEntries(
      [
        event("console.entry", 10, {
          source: "cdp.runtime",
          level: "info",
          text: "Information: WebSocket connected",
          stackTop: "connect @ https://app.example.test/static/js/vendor.js:0:99"
        }),
        event("console.entry", 20, {
          source: "cdp.log",
          level: "error",
          text: "Failed to load resource: the server responded with a status of 401 ()",
          url: "https://app.example.test/gw/bff/users?id=1",
          networkRequestId: "90080.1706"
        }),
        event("network.request", 21, { requestId: "90080.1706" })
      ],
      { siteOrigin: SITE }
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      level: "info",
      kind: "console",
      source: "cdp.runtime",
      location: { url: "https://app.example.test/static/js/vendor.js", line: 1, column: 100 },
      isThirdParty: false,
      hasStack: true
    });
    expect(entries[1]).toMatchObject({
      level: "error",
      reqId: "90080.1706",
      location: { url: "https://app.example.test/gw/bff/users?id=1" },
      hasStack: false
    });
  });

  it("treats errors, rejections and error-level events as errors with their stack", () => {
    const [exception, rejection, other] = buildConsoleEntries([
      event("error.exception", 1, {
        message: "AuthError: rejected",
        stack: "AuthError: rejected\n    at ensureUser (https://app.example.test/main.js:1:200)"
      }),
      event("error.unhandledrejection", 2, { reason: "boom" }),
      event("sys.notice", 3, { message: "worker crashed" }, { lvl: "error" })
    ]);

    expect(exception).toMatchObject({ level: "error", kind: "exception", hasStack: true });
    expect(exception?.location?.line).toBe(1);
    expect(rejection).toMatchObject({ level: "error", kind: "rejection", message: "boom" });
    expect(other).toMatchObject({ level: "error", kind: "other", message: "worker crashed" });
  });

  it("maps warning and verbose levels, joins arguments and falls back to the type", () => {
    expect(
      toConsoleEntry(event("console.entry", 1, { level: "warning", args: ["a", 1, { b: 2 }] }))
    ).toMatchObject({ level: "warn", message: 'a 1 {"b":2}' });
    expect(toConsoleEntry(event("console.entry", 1, { level: "verbose" }))?.level).toBe("debug");
    expect(toConsoleEntry(event("console.entry", 1, { level: "trace" }))).toMatchObject({
      level: "log",
      message: "console.entry"
    });
    expect(toConsoleEntry(event("network.request", 1, {}))).toBeNull();
  });

  it("marks rows from other sites as third-party and caps long messages", () => {
    const entry = toConsoleEntry(
      event("console.entry", 1, {
        level: "error",
        text: "x".repeat(5_000),
        url: "https://tracker.example.net/tag/a1"
      }),
      { siteOrigin: SITE }
    );

    expect(entry?.isThirdParty).toBe(true);
    expect(entry?.message.length).toBe(4_001);
    expect(
      toConsoleEntry(event("console.entry", 1, { level: "log", url: "https://x.net/" }))
        ?.isThirdParty
    ).toBe(false);
  });
});

describe("groupConsoleEntries", () => {
  it("folds similar rows into their first occurrence", () => {
    const entries = buildConsoleEntries([
      event("console.entry", 1, { level: "error", text: "fail", url: "https://a.test/x?1" }),
      event("console.entry", 2, { level: "log", text: "hello" }),
      event("console.entry", 3, { level: "error", text: "fail", url: "https://a.test/x?2" }),
      event("console.entry", 4, { level: "warn", text: "fail", url: "https://a.test/x" })
    ]);
    const groups = groupConsoleEntries(entries);

    expect(groups.map((group) => group.count)).toEqual([2, 1, 1]);
    expect(groups[0]?.memberIds).toEqual([entries[0]?.eventId, entries[2]?.eventId]);
    expect(groups[0]?.lastMono).toBe(3);
    expect(countConsoleLevels(entries)).toEqual({ error: 2, warn: 1, info: 0, log: 1, debug: 0 });
  });
});
