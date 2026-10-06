import { WebBlackboxPlayer } from "@webblackbox/player-sdk";
import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { beforeAll, describe, expect, it } from "vitest";

import type { LoadedArchive } from "../../state.js";
import { loadSyntheticArchive } from "../test-archive.js";
import {
  buildConsoleView,
  countConsoleErrors,
  describeLocation,
  findRelatedRequestId,
  selectConsoleEntries
} from "./console-model.js";
import { createSymbolicationService } from "./symbolication.js";

let archive: LoadedArchive;

beforeAll(async () => {
  archive = await loadSyntheticArchive();
});

const DEFAULTS = { levels: [], groupSimilar: true, hideThirdParty: true } as const;

describe("console view", () => {
  it("lists console output at every level, once per archive", () => {
    const entries = selectConsoleEntries(archive);
    const levels = new Set(entries.map((entry) => entry.level));

    expect([...levels].sort()).toEqual(["error", "info", "log", "warn"]);
    expect(selectConsoleEntries(archive)).toBe(entries);
    expect(
      entries.find((entry) => entry.hasStack && entry.message.startsWith("AuthError"))
    ).toBeTruthy();
    expect(countConsoleErrors(archive)).toBe(
      entries.filter((entry) => entry.level === "error").length
    );
  });

  it("hides third-party rows by default and counts them", () => {
    const view = buildConsoleView(archive, DEFAULTS, "");
    const all = buildConsoleView(archive, { ...DEFAULTS, hideThirdParty: false }, "");

    expect(view.hiddenThirdParty).toBeGreaterThan(0);
    expect(all.rows.length).toBe(view.rows.length + view.hiddenThirdParty);
    expect(view.rows.some((row) => row.entry.isThirdParty)).toBe(false);
  });

  it("narrows by level and text, and groups similar rows", () => {
    const errors = buildConsoleView(archive, { ...DEFAULTS, levels: ["error"] }, "");
    expect(errors.rows.every((row) => row.entry.level === "error")).toBe(true);
    expect(errors.levelCounts.log).toBeGreaterThan(0);

    const text = buildConsoleView(archive, DEFAULTS, "websocket CONNECTED");
    expect(text.rows).toHaveLength(1);

    const flags = buildConsoleView(archive, DEFAULTS, "feature");
    expect(flags.rows.map((row) => row.count)).toEqual([1, 1]);
    expect(buildConsoleView(archive, DEFAULTS, "no such message").rows).toEqual([]);
  });

  it("links rows to requests the archive holds", () => {
    const entries = selectConsoleEntries(archive);
    const tracker = entries.find((entry) => entry.reqId === "90080.1122");

    expect(tracker && findRelatedRequestId(archive, tracker)).toBe("90080.1122");
    expect(
      findRelatedRequestId(archive, { ...(tracker as NonNullable<typeof tracker>), reqId: "nope" })
    ).toBeNull();
  });

  it("describes locations by path", () => {
    expect(describeLocation("https://app.example.test/static/js/main.js?v=1", 1, 20)).toBe(
      "/static/js/main.js:1:20"
    );
    expect(describeLocation("webpack://app/./src/a.ts", 3)).toBe("src/a.ts:3");
    expect(describeLocation("file:///x/a.ts")).toBe("file:///x/a.ts");
    expect(describeLocation("not a url")).toBe("not a url");
  });
});

describe("symbolication service", () => {
  it("maps the logged AuthError through the source map embedded in the archive", async () => {
    const player = archive.player as WebBlackboxPlayer;
    const service = createSymbolicationService(player, {
      readServer: () => "",
      writeServer: () => undefined
    });
    const entry = selectConsoleEntries(archive).find(
      (item) => item.kind === "console" && item.hasStack && item.message.startsWith("AuthError")
    );
    const event = archive.model.eventById.get(entry?.eventId ?? "") as WebBlackboxEvent;
    let changes = 0;
    const unsubscribe = service.subscribe(() => {
      changes += 1;
    });

    service.request(event);
    expect(service.peek(event.id)).toEqual({ status: "pending" });

    await expect.poll(() => service.peek(event.id)?.status).toBe("done");
    const resolution = service.peek(event.id);
    const frames = resolution?.status === "done" ? resolution.frames : [];

    expect(frames[0]).toMatchObject({
      status: "mapped",
      original: { source: "webpack://app/src/live/session/ensure-casino-user.ts", line: 57 }
    });
    expect(frames[0]?.snippet?.highlightLine).toBe(57);
    expect(frames.map((frame) => frame.original?.line ?? frame.status)).toEqual([
      57,
      112,
      34,
      "no-map"
    ]);
    expect(changes).toBeGreaterThanOrEqual(2);

    service.request(event);
    expect(service.peek(event.id)?.status).toBe("done");

    service.setSymbolServer("ftp://symbols.example.test");
    expect(service.peek(event.id)).toBeUndefined();
    service.request(event);
    expect(service.sources()).toMatchObject({
      symbolServer: "ftp://symbols.example.test",
      symbolServerInvalid: true
    });

    service.setSymbolServer("");
    expect(service.sources()).toMatchObject({ symbolServer: "", symbolServerInvalid: false });
    service.setSymbolServer("not a url");
    expect(service.sources().symbolServerInvalid).toBe(true);
    service.setSymbolServer("https://symbols.example.test/maps");
    expect(service.sources().symbolServerInvalid).toBe(false);
    unsubscribe();
  });
});
