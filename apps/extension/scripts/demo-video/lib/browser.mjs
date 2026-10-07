// The demo Chrome on Windows: a throwaway profile, launch/close, CDP, and "real mouse" interaction
// with page elements (CDP finds the element, the agent moves the visible cursor and clicks).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CdpClient } from "../../lib/cdp-client.mjs";
import { findWindowsPids, toWinPath } from "./windows.mjs";

export const CHROME_EXE = "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe";
const CDP_READY_TIMEOUT_MS = 30_000;
const SCROLL_SETTLE_MS = 450;
const PROBE_TOLERANCE_PX = 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wipes and pre-seeds a profile directory: downloads go to the demo folder, no first-run noise. */
export function prepareProfile({ profileWsl, downloadsWsl, lang }) {
  rmSync(profileWsl, { recursive: true, force: true });
  mkdirSync(join(profileWsl, "Default"), { recursive: true });
  mkdirSync(downloadsWsl, { recursive: true });
  const preferences = {
    download: {
      default_directory: toWinPath(downloadsWsl),
      prompt_for_download: false,
      directory_upgrade: true
    },
    browser: { has_seen_welcome_page: true },
    intl: { accept_languages: lang === "ru" ? "ru-RU,ru,en-US,en" : "en-US,en" },
    translate: { enabled: false },
    credentials_enable_service: false,
    profile: { password_manager_enabled: false, exit_type: "Normal" }
  };
  writeFileSync(join(profileWsl, "Default", "Preferences"), JSON.stringify(preferences));
  writeFileSync(join(profileWsl, "First Run"), "");
}

/** Launches Chrome with the demo profile and connects CDP. */
export async function launchChrome({ profileWsl, lang, port, bounds, url = "about:blank", log }) {
  if (!existsSync(CHROME_EXE)) throw new Error(`Chrome not found at ${CHROME_EXE}`);
  const profileWin = toWinPath(profileWsl);
  const args = [
    `--user-data-dir=${profileWin}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
    "--disable-features=Translate,PrivacySandboxSettings4,HttpsUpgrades",
    "--hide-crash-restore-bubble",
    `--lang=${lang}`,
    `--window-position=${bounds.x},${bounds.y}`,
    `--window-size=${bounds.width},${bounds.height}`,
    url
  ];
  const child = spawn(CHROME_EXE, args, { detached: true, stdio: "ignore" });
  child.unref();
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  let version = null;
  while (!version) {
    try {
      const response = await fetch(`${base}/json/version`);
      if (response.ok) version = await response.json();
    } catch {
      // not up yet
    }
    if (!version) {
      if (Date.now() - started > CDP_READY_TIMEOUT_MS)
        throw new Error("Chrome CDP did not come up");
      await sleep(300);
    }
  }
  const cdp = new CdpClient(version.webSocketDebuggerUrl);
  await cdp.connect();
  const pids = findWindowsPids("chrome.exe", profileWin);
  log?.(`chrome ${version.Browser} up, ${pids.length} processes`);
  return { cdp, pids, profileWin, port };
}

/** Closes the demo browser (Browser.close), waiting until its processes are gone. */
export async function closeChrome(chrome) {
  try {
    await chrome.cdp.send("Browser.close", {}, { timeoutMs: 5000 });
  } catch {
    // already closing
  }
  chrome.cdp.close();
  for (let i = 0; i < 40; i += 1) {
    if (findWindowsPids("chrome.exe", chrome.profileWin).length === 0) return;
    await sleep(250);
  }
}

// ---- page elements ------------------------------------------------------------------------------

// Runs in the page: finds an element across shadow roots by css / text / accessible label.
const FIND_ELEMENT = `(q) => {
  const all = [];
  const visit = (root) => {
    for (const el of root.querySelectorAll("*")) {
      all.push(el);
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(document);
  const norm = (s) => String(s ?? "").replace(/\\s+/g, " ").trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) > 0.05;
  };
  let list = all;
  if (q.css) list = list.filter((el) => el.matches(q.css));
  if (q.text !== undefined) {
    list = list.filter((el) => {
      const t = norm(el.innerText ?? el.textContent);
      return q.exact === false ? t.includes(q.text) : t === q.text;
    });
  }
  if (q.label !== undefined) {
    list = list.filter((el) => {
      const l = norm(el.getAttribute("aria-label") ?? el.getAttribute("title") ?? "");
      return q.exact === false ? l.includes(q.label) : l === q.label;
    });
  }
  list = list.filter(visible);
  if (q.text !== undefined) {
    // innermost match: drop elements that contain another match
    list = list.filter((el) => !list.some((other) => other !== el && el.contains(other)));
  }
  return list[q.index ?? 0] ?? null;
}`;

const PROBE_INSTALL = `(() => {
  if (window.__wbbProbeInstalled) return true;
  window.__wbbProbeInstalled = true;
  window.__wbbProbe = null;
  addEventListener("mousemove", (e) => {
    window.__wbbProbe = { dx: e.screenX - e.clientX, dy: e.screenY - e.clientY, at: Date.now() };
  }, { capture: true, passive: true });
  return true;
})()`;

/**
 * A page (tab or extension popup) driven with the real cursor. `hwnd` is the Windows window that
 * shows it; the screen offset of its viewport is guessed from the window frame and then corrected
 * from the page's own mousemove events.
 */
export class DemoPage {
  constructor({ session, agent, hwnd, offsets, targetId, beforeInput }) {
    this.session = session;
    this.agent = agent;
    this.hwnd = hwnd;
    this.offsets = offsets;
    this.targetId = targetId;
    /** Runs before the cursor heads for an element (tabs: close the extension popup first). */
    this.beforeInput = beforeInput ?? (async () => undefined);
  }

  evaluate(expression, timeoutMs = 15_000) {
    return this.session.evaluate(expression, { timeoutMs });
  }

  /** Calls `fn` (source) in the page with the found element; resolves to its return value. */
  async withElement(query, fnSource) {
    return this.evaluate(
      `(() => { const el = (${FIND_ELEMENT})(${JSON.stringify(query)}); if (!el) return null; return (${fnSource})(el); })()`
    );
  }

  async waitFor(query, timeoutMs = 15_000) {
    const started = Date.now();
    for (;;) {
      const found = await this.withElement(query, "() => true");
      if (found) return;
      if (Date.now() - started > timeoutMs) {
        throw new Error(`element not found: ${JSON.stringify(query)}`);
      }
      await sleep(200);
    }
  }

  async waitForExpression(expression, timeoutMs = 15_000) {
    const started = Date.now();
    for (;;) {
      if (await this.evaluate(`Boolean(${expression})`)) return;
      if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${expression}`);
      await sleep(200);
    }
  }

  /** Client-space rect of the element, scrolled into view (smoothly) when needed. */
  async rect(query, timeoutMs = 15_000) {
    await this.waitFor(query, timeoutMs);
    const scrolled = await this.withElement(
      query,
      `(el) => {
        const r = el.getBoundingClientRect();
        const inView = r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
        if (!inView) el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
        return !inView;
      }`
    );
    if (scrolled) await sleep(SCROLL_SETTLE_MS + 250);
    return this.withElement(
      query,
      `(el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height, innerWidth, innerHeight }; }`
    );
  }

  async guessOffset(innerWidth, innerHeight) {
    const frame = await this.agent.call("windowRect", { hwnd: this.hwnd });
    const side = Math.max(0, Math.round((frame.width - innerWidth) / 2));
    return { dx: frame.left + side, dy: frame.bottom - side - innerHeight };
  }

  /** Moves the visible cursor onto the element (correcting the offset once from the probe). */
  async pointAt(query, { anchor = "center", timeoutMs } = {}) {
    await this.beforeInput();
    await this.evaluate(PROBE_INSTALL);
    const r = await this.rect(query, timeoutMs);
    if (!r) throw new Error(`element vanished: ${JSON.stringify(query)}`);
    const local = anchorPoint(r, anchor);
    const key = String(this.hwnd);
    const offset = this.offsets.get(key) ?? (await this.guessOffset(r.innerWidth, r.innerHeight));
    await this.agent.call("moveTo", { x: offset.dx + local.x, y: offset.dy + local.y });
    await sleep(60);
    const probe = await this.evaluate("window.__wbbProbe");
    let final = { x: offset.dx + local.x, y: offset.dy + local.y };
    if (probe && typeof probe.dx === "number") {
      const corrected = { dx: probe.dx, dy: probe.dy };
      this.offsets.set(key, corrected);
      if (
        Math.abs(corrected.dx - offset.dx) > PROBE_TOLERANCE_PX ||
        Math.abs(corrected.dy - offset.dy) > PROBE_TOLERANCE_PX
      ) {
        final = { x: corrected.dx + local.x, y: corrected.dy + local.y };
        await this.agent.call("moveTo", { ...final, durationMs: 220 });
      }
    }
    return final;
  }

  async click(query, options = {}) {
    await this.pointAt(query, options);
    await this.agent.call("click", {
      button: options.button ?? "left",
      count: options.count ?? 1,
      settleMs: options.settleMs ?? 180
    });
    await sleep(options.afterMs ?? 350);
  }

  async hover(query, holdMs = 600) {
    await this.pointAt(query);
    await sleep(holdMs);
  }

  /** Clicks a field, selects what is in it, and types `text` with real key presses. */
  async typeInto(query, text, { clear = true, charDelayMs = 75 } = {}) {
    await this.click(query, { afterMs: 150 });
    // Keys go wherever the focus is: refuse to type unless it is in this very field.
    const focused = await this.withElement(
      query,
      "(el) => document.hasFocus() && (el === document.activeElement || el.contains(document.activeElement))"
    );
    if (!focused) throw new Error(`refusing to type: ${JSON.stringify(query)} has no focus`);
    if (clear) {
      await this.agent.call("keys", { combo: "ctrl+a" });
      await this.agent.call("keys", { combo: "backspace" });
    }
    await this.agent.call("type", { text, charDelayMs }, 120_000);
  }

  async close() {
    await this.session.close();
  }
}

function anchorPoint(rect, anchor) {
  if (anchor === "left")
    return { x: rect.x + Math.min(24, rect.width / 2), y: rect.y + rect.height / 2 };
  if (typeof anchor === "object") return { x: rect.x + anchor.x, y: rect.y + anchor.y };
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Waits for a CDP target matching `predicate(targetInfo)` and attaches to it. */
export async function attachTarget(chrome, predicate, timeoutMs = 15_000) {
  const started = Date.now();
  for (;;) {
    const { targetInfos } = await chrome.cdp.send("Target.getTargets");
    const target = targetInfos.find(predicate);
    if (target) {
      const session = await chrome.cdp.attachToTarget(target.targetId);
      await session.send("Runtime.enable").catch(() => undefined);
      return { session, target };
    }
    if (Date.now() - started > timeoutMs) throw new Error("target not found");
    await sleep(200);
  }
}
