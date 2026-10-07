// The API scenarios use: start the demo Chrome, find pages/popups/native UI, and act on them
// with the visible cursor and real key presses.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { attachTarget, DemoPage, launchChrome, prepareProfile } from "./browser.mjs";
import { findWindowsPids } from "./windows.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const POPUP_MIN_WIDTH = 280;
const POPUP_MAX_WIDTH = 820;

export function createContext({ agent, config, lang, servers, log }) {
  const offsets = new Map();
  let marker = () => undefined;
  let extraGuardPids = [];

  const ctx = {
    agent,
    config,
    lang,
    servers,
    log,
    chrome: null,
    mainHwnd: null,
    /** Scratch space for a scenario's steps (windows, pages found earlier in the take). */
    state: {},
    profileWsl: join(config.workDirWsl, `profile-${lang}`),
    downloadsWsl: join(config.workDirWsl, "downloads"),

    setMarker(fn) {
      marker = fn;
    },
    mark(text) {
      marker(text);
    },
    pause: sleep,

    /**
     * Starts Chrome on a fresh profile, or on a copy of a prepared one (`fromProfileWsl`), and
     * places its window on the recorded rectangle.
     */
    async startChrome({ url = "about:blank", fromProfileWsl } = {}) {
      if (fromProfileWsl) {
        if (!existsSync(fromProfileWsl))
          throw new Error(`missing prepared profile ${fromProfileWsl}`);
        rmSync(ctx.profileWsl, { recursive: true, force: true });
        cpSync(fromProfileWsl, ctx.profileWsl, { recursive: true });
      } else {
        prepareProfile({ profileWsl: ctx.profileWsl, downloadsWsl: ctx.downloadsWsl, lang });
      }
      // A clean downloads folder for every take (the profile's download.default_directory).
      rmSync(ctx.downloadsWsl, { recursive: true, force: true });
      mkdirSync(ctx.downloadsWsl, { recursive: true });
      ctx.chrome = await launchChrome({
        profileWsl: ctx.profileWsl,
        lang,
        port: config.cdpPort,
        bounds: config.window,
        url,
        log
      });
      const main = await ctx.waitWindow(
        (w) => w.className === "Chrome_WidgetWin_1" && w.title.endsWith("Google Chrome"),
        20_000
      );
      ctx.mainHwnd = main.hwnd;
      await agent.call("placeWindow", { hwnd: ctx.mainHwnd, ...config.window });
      await agent.call("foreground", { hwnd: ctx.mainHwnd });
      await ctx.guard();
      await sleep(800);
      return ctx.chrome;
    },

    /** Restricts input to the demo Chrome (plus `extra` PIDs, e.g. Explorer during unzip). */
    async guard(extra = extraGuardPids) {
      extraGuardPids = extra;
      await agent.call("guard", { pids: [...(ctx.chrome?.pids ?? []), ...extra] });
    },

    async refreshPids() {
      ctx.chrome.pids = findWindowsPids("chrome.exe", ctx.chrome.profileWin);
      await ctx.guard();
    },

    async focusMain() {
      if (!ctx.mainHwnd) return;
      const ok = await agent.call("foreground", { hwnd: ctx.mainHwnd });
      if (!ok) log("warning: could not bring the demo window to the front");
    },

    /** The recorded rectangle: the main window's visible frame, even-sized for H.264. */
    async captureRect() {
      const rect = await agent.call("windowRect", { hwnd: ctx.mainHwnd });
      const width = rect.width - (rect.width % 2);
      const height = rect.height - (rect.height % 2);
      return { left: rect.left, top: rect.top, width, height };
    },

    /**
     * Polls top-level windows of the demo Chrome (+ guard extras) until one matches; `pids: []`
     * searches every window (used for Explorer, which may spawn a new process).
     */
    async waitWindow(predicate, timeoutMs = 10_000, pids = undefined) {
      const started = Date.now();
      for (;;) {
        const windows = await agent.call("windows", {
          pids: pids ?? [...(ctx.chrome?.pids ?? []), ...extraGuardPids]
        });
        const found = windows.find((w) => w.rect.width > 0 && predicate(w));
        if (found) return found;
        if (Date.now() - started > timeoutMs) throw new Error("window did not appear");
        await sleep(200);
      }
    },

    /** A tab (in the main window) whose URL matches. */
    async page(match, timeoutMs = 15_000) {
      const test = typeof match === "function" ? match : (url) => url.startsWith(match);
      const { session, target } = await attachTarget(
        ctx.chrome,
        (t) => t.type === "page" && test(t.url),
        timeoutMs
      );
      return new DemoPage({
        session,
        agent,
        hwnd: ctx.mainHwnd,
        offsets,
        targetId: target.targetId
      });
    },

    /** The extension's action popup: its CDP target and its own Windows window. */
    async popup(timeoutMs = 10_000) {
      const { session, target } = await attachTarget(
        ctx.chrome,
        (t) => t.url.startsWith("chrome-extension://") && t.url.includes("/popup.html"),
        timeoutMs
      );
      const win = await ctx.waitWindow(
        (w) =>
          w.hwnd !== ctx.mainHwnd &&
          w.className === "Chrome_WidgetWin_1" &&
          w.rect.width >= POPUP_MIN_WIDTH &&
          w.rect.width <= POPUP_MAX_WIDTH,
        timeoutMs
      );
      offsets.delete(String(win.hwnd));
      return new DemoPage({ session, agent, hwnd: win.hwnd, offsets, targetId: target.targetId });
    },

    async uiaFind(query, hwnd = ctx.mainHwnd) {
      return agent.call("uiaFind", { hwnd, timeoutMs: 8000, visibleOnly: true, ...query }, 60_000);
    },

    /** Finds a native UI element by accessible name and clicks it with the visible cursor. */
    async uiaClick(query, { hwnd = ctx.mainHwnd, button = "left", afterMs = 400 } = {}) {
      const element = await ctx.uiaFind(query, hwnd);
      if (!element?.center) throw new Error(`no clickable rect for ${JSON.stringify(query)}`);
      await agent.call("click", { x: element.center.x, y: element.center.y, button });
      await sleep(afterMs);
      return element;
    },

    /** Types a URL into the address bar like a person would. */
    async navigate(url) {
      const omnibox = await ctx.uiaFind({ controlType: "Edit", name: ctx.omniboxName() });
      await agent.call("click", { x: omnibox.center.x, y: omnibox.center.y });
      await agent.call("keys", { combo: "ctrl+a" });
      await agent.call("type", { text: url, charDelayMs: 55 }, 60_000);
      await sleep(250);
      await agent.call("keys", { combo: "enter" });
      await sleep(1200);
    },

    omniboxName() {
      return lang === "ru" ? "Адресная строка и строка поиска" : "Address and search bar";
    }
  };
  return ctx;
}
