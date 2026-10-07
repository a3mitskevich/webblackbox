// Pure caption logic for the demo-video recorder: reading time, caption cues from a take's
// timeline, and the ASS subtitle file burned into the final video. No I/O here, so CI covers it.

// The videos are recorded in Russian only (owner decision). Another language needs its captions
// in every scenario step, a `--lang` take on a Windows/Chrome in that language, and an entry here.
export const LANGS = Object.freeze(["ru"]);

const MIN_CAPTION_MS = 2200;
/** Height of the caption bar added under the recorded frame, and the caption font size. */
export const CAPTION_BAR_HEIGHT = 150;
export const CAPTION_FONT_SIZE = 46;
const CHARS_PER_SECOND = 15;
const CAPTION_LEAD_MS = 500;

/** How long a caption must stay on screen to be read comfortably. */
export function readingTimeMs(text) {
  const length = String(text ?? "").trim().length;
  return Math.max(MIN_CAPTION_MS, Math.round((length / CHARS_PER_SECOND) * 1000) + CAPTION_LEAD_MS);
}

/**
 * Turns caption marks recorded during a take into cues. Each caption lasts until the next mark,
 * the last one until `endMs`. Marks before 0 are clamped (captions set before the first frame).
 *
 * @param {ReadonlyArray<{ atMs: number, text: string }>} marks
 * @param {number} endMs
 * @returns {Array<{ startMs: number, endMs: number, text: string }>}
 */
export function cuesFromMarks(marks, endMs) {
  const sorted = [...marks]
    .map((mark) => ({ atMs: Math.max(0, Math.round(mark.atMs)), text: String(mark.text ?? "") }))
    .sort((a, b) => a.atMs - b.atMs);
  return sorted
    .map((mark, index) => ({
      startMs: mark.atMs,
      endMs: Math.min(endMs, sorted[index + 1]?.atMs ?? endMs),
      text: mark.text
    }))
    .filter((cue) => cue.text.trim().length > 0 && cue.endMs > cue.startMs);
}

/**
 * A dry-run timeline: what the captions of a scenario would look like if every step took exactly
 * its reading time plus `actionMs`. Used by `run.mjs --dry-run` and the unit test.
 *
 * @param {ReadonlyArray<{ say?: Record<string, string> }>} steps
 * @param {string} lang
 * @param {number} [actionMs]
 */
export function dryRunMarks(steps, lang, actionMs = 1500) {
  let atMs = 0;
  const marks = [];
  for (const step of steps) {
    if (!step.say) {
      atMs += actionMs;
      continue;
    }
    const text = step.say[lang];
    marks.push({ atMs, text });
    atMs += Math.max(readingTimeMs(text), actionMs);
  }
  return { marks, endMs: atMs + 1000 };
}

/** 83456 -> "0:01:23.46" (ASS centiseconds). */
export function formatAssTime(ms) {
  const total = Math.max(0, Math.round(ms / 10));
  const cs = total % 100;
  const seconds = Math.floor(total / 100) % 60;
  const minutes = Math.floor(total / 6000) % 60;
  const hours = Math.floor(total / 360000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(cs)}`;
}

/** Caption text -> ASS dialogue text: no override blocks, explicit line breaks as \N. */
export function escapeAssText(text) {
  return String(text)
    .replace(/\\/gu, "⧵")
    .replace(/\{/gu, "(")
    .replace(/\}/gu, ")")
    .replace(/\r?\n/gu, "\\N");
}

/**
 * The ASS file for the final video. The raw take is `width` x `videoHeight`; the final frame adds
 * a caption bar of `barHeight` below it, so captions never cover the UI being shown.
 *
 * @param {{ cues: ReadonlyArray<{ startMs: number, endMs: number, text: string }>,
 *   width: number, videoHeight: number, barHeight: number, fontName?: string, fontSize?: number,
 *   title?: string }} options
 */
export function buildAss(options) {
  const { cues, width, videoHeight, barHeight } = options;
  const fontName = options.fontName ?? "Segoe UI";
  const fontSize = options.fontSize ?? CAPTION_FONT_SIZE;
  const height = videoHeight + barHeight;
  // Every caption is centred in the bar, whether it takes one line or two.
  const anchor = `{\\an5\\pos(${Math.round(width / 2)},${videoHeight + Math.round(barHeight / 2)})}`;
  const header = [
    "[Script Info]",
    `Title: ${escapeAssText(options.title ?? "WebBlackbox demo")}`,
    "ScriptType: v4.00+",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Caption,${fontName},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,48,48,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
  ];
  const events = [...cues]
    .sort((a, b) => a.startMs - b.startMs)
    .map(
      (cue) =>
        `Dialogue: 0,${formatAssTime(cue.startMs)},${formatAssTime(cue.endMs)},Caption,,0,0,0,,${anchor}${escapeAssText(cue.text)}`
    );
  return `${[...header, ...events].join("\n")}\n`;
}

/** "C:\\Users\\Admin\\x" -> "/mnt/c/Users/Admin/x" (WSL automount of a drive path). */
export function winToWslPath(winPath) {
  const match = /^([A-Za-z]):[\\/]*(.*)$/u.exec(String(winPath));
  if (!match) throw new Error(`not a drive path: ${winPath}`);
  const rest = match[2].replace(/[\\/]+/gu, "/").replace(/\/$/u, "");
  return `/mnt/${match[1].toLowerCase()}${rest ? `/${rest}` : ""}`;
}

/**
 * Checks a scenario definition: unique step ids and a caption in every language for every step
 * that has one. Returns a list of problems (empty when valid).
 *
 * @param {{ id: string, title: Record<string, string>, steps: ReadonlyArray<{ id: string, say?: Record<string, string>, run?: unknown }> }} scenario
 */
export function validateScenario(scenario) {
  const problems = [];
  const seen = new Set();
  for (const lang of LANGS) {
    if (!scenario.title?.[lang]?.trim()) problems.push(`${scenario.id}: missing title.${lang}`);
  }
  for (const step of scenario.steps) {
    if (seen.has(step.id)) problems.push(`${scenario.id}: duplicate step id ${step.id}`);
    seen.add(step.id);
    if (step.run !== undefined && typeof step.run !== "function") {
      problems.push(`${scenario.id}/${step.id}: run is not a function`);
    }
    if (!step.say) continue;
    for (const lang of LANGS) {
      if (!step.say[lang]?.trim()) problems.push(`${scenario.id}/${step.id}: missing say.${lang}`);
    }
  }
  if (!scenario.steps.some((step) => step.say)) problems.push(`${scenario.id}: no captions`);
  return problems;
}
