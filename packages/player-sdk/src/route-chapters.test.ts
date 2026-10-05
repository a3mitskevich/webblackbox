import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import { buildRouteChapters, formatRouteLabel } from "./route-chapters.js";

let sequence = 0;

function event(type: string, mono: number, data: unknown = {}): WebBlackboxEvent {
  sequence += 1;
  return {
    v: 1,
    sid: "S-1",
    tab: 1,
    t: 1_000 + mono,
    mono,
    type: type as WebBlackboxEvent["type"],
    id: `E-${sequence}`,
    data
  };
}

const APP = "https://app.example.test/?lng=en";

describe("formatRouteLabel", () => {
  it("prefers the hash route and falls back to the path", () => {
    expect(formatRouteLabel(`${APP}#/lobby`)).toBe("#/lobby");
    expect(formatRouteLabel("https://app.example.test/cart?x=1")).toBe("/cart");
    expect(formatRouteLabel("https://app.example.test/#")).toBe("/");
    expect(formatRouteLabel("  not a url ")).toBe("not a url");
  });
});

describe("buildRouteChapters", () => {
  it("returns nothing for an empty session", () => {
    expect(buildRouteChapters([])).toEqual([]);
  });

  it("splits the session at top-level navigations and merges repeated routes", () => {
    const events = [
      event("meta.config", 0),
      event("console.entry", 50, { routeContext: { url: `${APP}#/error` } }),
      event("nav.commit", 1_900, {
        type: "Navigation",
        frame: { id: "MAIN", url: APP }
      }),
      event("nav.commit", 2_300, {
        type: "Navigation",
        frame: { id: "CHILD", parentId: "MAIN", url: "about:blank" }
      }),
      event("nav.hash", 2_600, { frameId: "MAIN", url: `${APP}#/error` }),
      event("nav.hash", 3_000, { frameId: "CHILD", url: "https://other.test/#/ignored" }),
      event("nav.history.push", 9_450, { frameId: "MAIN", url: `${APP}#/lobby` }),
      event("nav.history.replace", 10_970, { frameId: "MAIN", url: `${APP}#/lobby` }),
      event("nav.hash", 10_980, { url: `${APP}#/live/64` }),
      event("nav.hash", 11_000, { frameId: "MAIN" }),
      event("meta.session.end", 17_800)
    ];

    const chapters = buildRouteChapters(events);

    expect(
      chapters.map(({ kind, label, startMono, endMono }) => [kind, label, startMono, endMono])
    ).toEqual([
      ["load", "#/error", 0, 1_900],
      ["reload", "/", 1_900, 2_600],
      ["route", "#/error", 2_600, 9_450],
      ["route", "#/lobby", 9_450, 10_980],
      ["route", "#/live/64", 10_980, 17_800]
    ]);
    expect(chapters[1]?.eventId).toBe(events[2]?.id);
    expect(chapters[0]?.eventId).toBeUndefined();
  });

  it("marks reloads and uses the session start URL or the given initial URL", () => {
    const withStart = buildRouteChapters([
      event("meta.session.start", 0, { url: "https://shop.test/cart" }),
      event("nav.reload", 400, { url: "https://shop.test/cart" }),
      event("nav.commit", 900, { type: "Reload", url: "https://shop.test/cart" })
    ]);

    expect(withStart.map((chapter) => [chapter.kind, chapter.label])).toEqual([
      ["load", "/cart"],
      ["reload", "/cart"],
      ["reload", "/cart"]
    ]);

    const withOption = buildRouteChapters([event("user.click", 10), event("user.click", 30)], {
      initialUrl: "https://shop.test/",
      endMono: 50
    });

    expect(withOption).toEqual([
      { kind: "load", label: "/", url: "https://shop.test/", startMono: 10, endMono: 50 }
    ]);
  });

  it("treats a document load of the open URL as a reload", () => {
    const chapters = buildRouteChapters(
      [
        event("user.click", 0),
        event("nav.commit", 1_000, { frame: { id: "MAIN", url: "https://shop.test/?lng=en" } }),
        event("nav.commit", 2_000, { frame: { id: "MAIN", url: "https://shop.test/cart" } }),
        event("nav.commit", 3_000, { frame: { id: "MAIN", url: "not a url" } }),
        event("nav.commit", 4_000, { frame: { id: "MAIN", url: "not a url" } })
      ],
      { initialUrl: "https://shop.test" }
    );

    expect(chapters.map((chapter) => [chapter.kind, chapter.label])).toEqual([
      ["load", "/"],
      ["reload", "/"],
      ["document", "/cart"],
      ["document", "not a url"],
      ["reload", "not a url"]
    ]);
  });

  it("skips the load chapter when the first event is a navigation or no URL is known", () => {
    const chapters = buildRouteChapters([
      event("nav.commit", 0, { frame: { id: "MAIN", url: "https://shop.test/a" } }),
      event("nav.commit", 100, { frame: { id: "MAIN" } })
    ]);

    expect(chapters.map((chapter) => chapter.label)).toEqual(["/a"]);
    expect(buildRouteChapters([event("user.click", 0)])).toEqual([]);
  });
});
