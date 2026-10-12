import { describe, expect, it, vi } from "vitest";

import {
  CONTENT_EVENT_BATCH_MAX,
  createRejectedMessageLog,
  MARKER_MESSAGE_MAX_CHARS,
  parseExtensionInboundMessage,
  REJECTED_MESSAGE_LOG_MAX_PER_WINDOW,
  REJECTED_MESSAGE_LOG_WINDOW_MS
} from "./inbound-messages.js";

const EVENT = {
  source: "content",
  rawType: "click",
  sid: "S-1",
  t: 1_700_000_000_000,
  mono: 12.5,
  payload: { x: 1 }
};

type KindCase = {
  kind: string;
  /** The smallest valid message of the kind. */
  minimal: Record<string, unknown>;
  /** A valid message with every optional field set. */
  complete: Record<string, unknown>;
  required: string[];
  /** Per field: values of the wrong type or shape. */
  wrongTypes: Record<string, unknown[]>;
};

const KIND_CASES: KindCase[] = [
  {
    kind: "ui.start",
    minimal: { kind: "ui.start", mode: "lite" },
    complete: {
      kind: "ui.start",
      tabId: 17,
      mode: "full",
      reloadPage: true,
      visualCapture: "none",
      profileId: "builtin:qa"
    },
    required: ["mode"],
    wrongTypes: {
      mode: ["max", 1, null],
      tabId: ["17", -1, 1.5, Number.NaN, null],
      reloadPage: ["yes", 1],
      visualCapture: ["video", true],
      profileId: ["", 7, "x".repeat(257)]
    }
  },
  {
    kind: "ui.stop",
    minimal: { kind: "ui.stop" },
    complete: { kind: "ui.stop", tabId: 0 },
    required: [],
    wrongTypes: { tabId: ["7", -3, Number.POSITIVE_INFINITY, {}] }
  },
  {
    kind: "ui.export",
    minimal: { kind: "ui.export", sid: "S-1" },
    complete: {
      kind: "ui.export",
      sid: "S-1",
      passphrase: "correct horse",
      saveAs: false,
      policy: {
        includeScreenshots: true,
        includeScreenRecordings: false,
        maxArchiveBytes: 1024,
        recentWindowMs: 60_000
      }
    },
    required: ["sid"],
    wrongTypes: {
      sid: ["", 1, null],
      passphrase: [12_345_678, "p".repeat(4_097)],
      saveAs: ["false"],
      policy: [
        "all",
        [],
        null,
        { includeScreenshots: "yes" },
        { maxArchiveBytes: "1mb" },
        { recentWindowMs: Number.NaN }
      ]
    }
  },
  {
    kind: "ui.delete",
    minimal: { kind: "ui.delete", sid: "S-1" },
    complete: { kind: "ui.delete", sid: "S-1" },
    required: ["sid"],
    wrongTypes: { sid: ["", 1, ["S-1"]] }
  },
  {
    kind: "ui.annotate",
    minimal: { kind: "ui.annotate", sid: "S-1" },
    complete: { kind: "ui.annotate", sid: "S-1", tags: ["bug", "login"], note: "fails" },
    required: ["sid"],
    wrongTypes: {
      sid: [42],
      tags: ["bug", [1], Array.from({ length: 257 }, () => "t")],
      note: [7, "n".repeat(10_001)]
    }
  },
  {
    kind: "ui.request-session-list",
    minimal: { kind: "ui.request-session-list" },
    complete: { kind: "ui.request-session-list" },
    required: [],
    wrongTypes: {}
  },
  {
    kind: "ui.ack-profile-cancel",
    minimal: { kind: "ui.ack-profile-cancel", sid: "S-1" },
    complete: { kind: "ui.ack-profile-cancel", sid: "S-1" },
    required: ["sid"],
    wrongTypes: { sid: [false] }
  },
  {
    kind: "ui.resolve-profile",
    minimal: { kind: "ui.resolve-profile" },
    complete: { kind: "ui.resolve-profile", tabId: 3, profileId: "auto" },
    required: [],
    wrongTypes: { tabId: ["3"], profileId: [3, ""] }
  },
  {
    kind: "content.events",
    minimal: { kind: "content.events", events: [] },
    complete: {
      kind: "content.events",
      events: [{ ...EVENT, nav: "N-1", frame: "content-frame-2" }]
    },
    required: ["events"],
    wrongTypes: { events: ["click", { 0: EVENT }, null] }
  },
  {
    kind: "content.marker",
    minimal: { kind: "content.marker", message: "" },
    complete: { kind: "content.marker", message: "Keyboard marker" },
    required: ["message"],
    wrongTypes: { message: [1, null, { text: "x" }] }
  },
  {
    kind: "content.ready",
    minimal: { kind: "content.ready" },
    complete: { kind: "content.ready" },
    required: [],
    wrongTypes: {}
  },
  {
    kind: "content.stop-drained",
    minimal: { kind: "content.stop-drained", sid: "S-1" },
    complete: { kind: "content.stop-drained", sid: "S-1" },
    required: ["sid"],
    wrongTypes: { sid: ["", 9] }
  }
];

function wrongTypeCases(wrongTypes: Record<string, unknown[]>): Array<[string, unknown]> {
  return Object.entries(wrongTypes).flatMap(([field, values]) =>
    values.map((value): [string, unknown] => [field, value])
  );
}

describe("parseExtensionInboundMessage", () => {
  describe.each(KIND_CASES)("$kind", ({ kind, minimal, complete, required, wrongTypes }) => {
    it("accepts the smallest valid message and one with every field", () => {
      expect(parseExtensionInboundMessage(minimal)).toEqual({
        ok: true,
        message: minimal,
        droppedEvents: 0
      });
      expect(parseExtensionInboundMessage(complete)).toEqual({
        ok: true,
        message: complete,
        droppedEvents: 0
      });
    });

    it("leaves out unknown fields and returns a new object", () => {
      const result = parseExtensionInboundMessage({ ...complete, extra: "x", admin: true });

      expect(result).toEqual({ ok: true, message: complete, droppedEvents: 0 });
      expect(result.ok && result.message).not.toBe(complete);
    });

    if (required.length > 0) {
      it.each(required)("rejects the message without %s", (field) => {
        const rest = Object.fromEntries(Object.entries(complete).filter(([key]) => key !== field));

        expect(parseExtensionInboundMessage(rest)).toEqual({ ok: false, kind, reason: field });
      });
    }

    const wrong = wrongTypeCases(wrongTypes);

    if (wrong.length > 0) {
      it.each(wrong)("rejects %s = %j", (field, value) => {
        expect(parseExtensionInboundMessage({ ...complete, [field]: value })).toEqual({
          ok: false,
          kind,
          reason: field
        });
      });
    }
  });

  it.each([null, undefined, "ui.start", 7, ["ui.start"]])("rejects the non-object %j", (raw) => {
    expect(parseExtensionInboundMessage(raw)).toEqual({
      ok: false,
      kind: "unknown",
      reason: "not an object"
    });
  });

  it("rejects a missing or non-string kind", () => {
    expect(parseExtensionInboundMessage({ mode: "lite" })).toMatchObject({
      ok: false,
      reason: "kind is not a string"
    });
    expect(parseExtensionInboundMessage({ kind: 1 })).toMatchObject({ ok: false });
  });

  it("rejects unknown kinds, including the service worker's own and the offscreen ones", () => {
    for (const kind of ["sw.recording-status", "offscreen.ready", "ui.Start", "content.script"]) {
      expect(parseExtensionInboundMessage({ kind })).toEqual({
        ok: false,
        kind,
        reason: "unknown kind"
      });
    }

    expect(parseExtensionInboundMessage({ kind: "k".repeat(500) })).toMatchObject({
      kind: "k".repeat(64)
    });
  });

  it("caps the marker text", () => {
    const result = parseExtensionInboundMessage({
      kind: "content.marker",
      message: "m".repeat(MARKER_MESSAGE_MAX_CHARS + 50)
    });

    expect(result.ok && result.message).toEqual({
      kind: "content.marker",
      message: "m".repeat(MARKER_MESSAGE_MAX_CHARS)
    });
  });

  describe("content.events", () => {
    it("keeps valid events, counts and drops malformed ones", () => {
      const malformed = [
        null,
        "click",
        { ...EVENT, source: "cdp" },
        { ...EVENT, source: "system" },
        { ...EVENT, rawType: "" },
        { ...EVENT, rawType: "r".repeat(65) },
        { ...EVENT, rawType: 3 },
        { ...EVENT, sid: undefined },
        { ...EVENT, t: Number.NaN },
        { ...EVENT, mono: "1" },
        { ...EVENT, payload: undefined },
        { ...EVENT, nav: 1 },
        { ...EVENT, frame: {} }
      ];
      const result = parseExtensionInboundMessage({
        kind: "content.events",
        events: [EVENT, ...malformed, { ...EVENT, rawType: "keydown" }]
      });

      expect(result).toEqual({
        ok: true,
        message: { kind: "content.events", events: [EVENT, { ...EVENT, rawType: "keydown" }] },
        droppedEvents: malformed.length
      });
    });

    it("never takes the tab, the CDP target or extra fields from an event", () => {
      const result = parseExtensionInboundMessage({
        kind: "content.events",
        events: [{ ...EVENT, tabId: 99, targetId: "T", cdpSessionId: "C", extra: true }]
      });

      expect(result.ok && result.message).toEqual({ kind: "content.events", events: [EVENT] });
    });

    it("accepts a payload of any value but undefined", () => {
      const result = parseExtensionInboundMessage({
        kind: "content.events",
        events: [
          { ...EVENT, payload: null },
          { ...EVENT, payload: "text" }
        ]
      });

      expect(result).toMatchObject({ ok: true, droppedEvents: 0 });
    });

    it("rejects a batch over the cap", () => {
      expect(
        parseExtensionInboundMessage({
          kind: "content.events",
          events: Array.from({ length: CONTENT_EVENT_BATCH_MAX + 1 }, () => EVENT)
        })
      ).toEqual({ ok: false, kind: "content.events", reason: "too many events" });
    });
  });
});

describe("createRejectedMessageLog", () => {
  it("warns a few times per window, then reports how many it suppressed", () => {
    let now = 1_000;
    const warn = vi.fn();
    const log = createRejectedMessageLog({ now: () => now, warn });

    for (let index = 0; index < REJECTED_MESSAGE_LOG_MAX_PER_WINDOW + 7; index += 1) {
      log({ kind: "ui.start", reason: "mode", tabId: 4 });
    }

    expect(warn).toHaveBeenCalledTimes(REJECTED_MESSAGE_LOG_MAX_PER_WINDOW);
    expect(warn).toHaveBeenLastCalledWith("[WebBlackbox] dropped an inbound message", {
      kind: "ui.start",
      reason: "mode",
      tabId: 4
    });

    now += REJECTED_MESSAGE_LOG_WINDOW_MS - 1;
    log({ kind: "x", reason: "unknown kind" });
    expect(warn).toHaveBeenCalledTimes(REJECTED_MESSAGE_LOG_MAX_PER_WINDOW);

    now += 1;
    log({ kind: "x", reason: "unknown kind" });
    expect(warn).toHaveBeenCalledTimes(REJECTED_MESSAGE_LOG_MAX_PER_WINDOW + 1);
    expect(warn).toHaveBeenLastCalledWith("[WebBlackbox] dropped an inbound message", {
      kind: "x",
      reason: "unknown kind",
      suppressedBefore: 8
    });

    log({ kind: "x", reason: "unknown kind" });
    expect(warn).toHaveBeenLastCalledWith("[WebBlackbox] dropped an inbound message", {
      kind: "x",
      reason: "unknown kind"
    });
  });
});
