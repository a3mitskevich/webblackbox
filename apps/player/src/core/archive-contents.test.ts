import { beforeAll, describe, expect, it } from "vitest";

import { loadSyntheticArchive } from "../next/features/test-archive.js";
import type { LoadedArchive } from "../next/state.js";
import { buildArchiveContents } from "./archive-contents.js";

let archive: LoadedArchive;

beforeAll(async () => {
  archive = await loadSyntheticArchive();
});

describe("buildArchiveContents", () => {
  it("says what each kind of data holds and how complete it is", () => {
    const report = archive.player.getCaptureCompleteness();
    const contents = buildArchiveContents(archive.player.events, archive.model, report);

    expect(contents.playable).toBe(true);
    expect(contents.media.kind).not.toBe("none");
    expect(contents.network).toMatchObject({
      requests: report.network.requests,
      bodies: report.network.responseBodies
    });
    expect(contents.network.status).not.toBe("none");
    expect(contents.realtime.frames).toBe(report.realtime.wsFrames);
    expect(contents.console.errors).toBe(report.console.errors);
    expect(contents.profiles).toEqual([]);
    expect(contents.cancellation).toBeNull();
  });

  it("flags partial data and archives without playback events", () => {
    const report = archive.player.getCaptureCompleteness();
    const thin = {
      ...report,
      bodiesRequested: false,
      realtime: { ...report.realtime, wsFrames: 4, truncatedFrames: 1 },
      console: { ...report.console, entries: 3, errors: 2, withStack: 0 },
      storage: { ...report.storage, cookieSnapshots: 1, cookieValues: 0, localValues: 0 },
      dom: { ...report.dom, snapshots: 1, coverage: 0.1 },
      perf: { vitals: 0, longTasks: 0, traces: 0 }
    };
    const metaOnly = archive.player.events.filter((event) => event.type.startsWith("meta."));
    const contents = buildArchiveContents(
      metaOnly,
      { ...archive.model, screenshots: [], screenRecordings: [] },
      { ...thin, storage: { ...thin.storage, idbRecords: 0 } }
    );

    expect(contents.playable).toBe(false);
    expect(contents.media).toEqual({ kind: "none", status: "none" });
    expect(contents.network.status).toBe("partial");
    expect(contents.realtime.status).toBe("partial");
    expect(contents.console.status).toBe("partial");
    expect(contents.storage.status).toBe("partial");
    expect(contents.dom.status).toBe("partial");
    expect(contents.perf.status).toBe("none");
  });
});
