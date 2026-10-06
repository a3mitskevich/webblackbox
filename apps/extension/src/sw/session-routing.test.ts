import { describe, expect, it } from "vitest";

import { resolveRawEventSession } from "./session-routing.js";

type Session = { sid: string; tabId: number };

const recordingC: Session = { sid: "S-c", tabId: 3 };
const recordingD: Session = { sid: "S-d", tabId: 4 };

const maps = (byTab: Session[], bySid: Session[]) => ({
  byTab: new Map(byTab.map((session) => [session.tabId, session])),
  bySid: new Map(bySid.map((session) => [session.sid, session]))
});

describe("resolveRawEventSession", () => {
  it("keeps an event with the recording of the tab it came from, whatever sid it carries", () => {
    const { byTab, bySid } = maps([recordingC, recordingD], [recordingC, recordingD]);

    expect(resolveRawEventSession({ tabId: 3, sid: "S-d" }, byTab, bySid)).toBe(recordingC);
  });

  it("finds a draining recording (no longer listed by tab) by its sid", () => {
    const { byTab, bySid } = maps([recordingD], [recordingC, recordingD]);

    expect(resolveRawEventSession({ tabId: 3, sid: "S-c" }, byTab, bySid)).toBe(recordingC);
  });

  it("never hands a tab's late event to another tab's recording through the sid", () => {
    // Tab c stopped; its last flush carries tab d's sid (a status meant for d reached it).
    const { byTab, bySid } = maps([recordingD], [recordingC, recordingD]);

    expect(resolveRawEventSession({ tabId: 3, sid: "S-d" }, byTab, bySid)).toBeUndefined();
  });

  it("drops events of tabs nothing records", () => {
    const { byTab, bySid } = maps([recordingD], [recordingD]);

    expect(resolveRawEventSession({ tabId: 9 }, byTab, bySid)).toBeUndefined();
    expect(resolveRawEventSession({ tabId: 9, sid: 42 }, byTab, bySid)).toBeUndefined();
  });
});
