/** One parsed stack frame. Positions are 1-based, as browsers print them. */
export type StackFrame = {
  functionName?: string;
  /** Script URL as printed in the stack (query string included). */
  url: string;
  line: number;
  column: number;
  /** The source line this frame was parsed from. */
  raw: string;
};

export type ParseStackTraceOptions = {
  /** Frames to keep (default 64). */
  maxFrames?: number;
};

const DEFAULT_MAX_FRAMES = 64;
const MAX_STACK_CHARS = 64 * 1024;
const MAX_LINE_CHARS = 2_048;

// SpiderMonkey / JavaScriptCore: `fn@url:1:2`, `@url:1:2`, `global code@url:1:2`.
const GECKO_FRAME = /^([^@]*)@(.+)$/u;
const LOCATION_SUFFIX = /:(\d+):(\d+)$/u;
const CDP_STACK_TOP_SEPARATOR = " @ ";

/**
 * Parses V8 (Chrome, Edge, Node), SpiderMonkey (Firefox) and JavaScriptCore (Safari) stack
 * traces. Lines without a script position (the message line, native or eval frames) are
 * skipped.
 */
export function parseStackTrace(stack: string, options: ParseStackTraceOptions = {}): StackFrame[] {
  const maxFrames = Math.max(1, Math.floor(options.maxFrames ?? DEFAULT_MAX_FRAMES));
  const frames: StackFrame[] = [];

  for (const line of stack.slice(0, MAX_STACK_CHARS).split(/\r?\n/u)) {
    if (frames.length >= maxFrames) {
      break;
    }

    const frame = parseStackLine(line.slice(0, MAX_LINE_CHARS));

    if (frame) {
      frames.push(frame);
    }
  }

  return frames;
}

/** Parses one stack line in any supported format; `null` when it carries no script position. */
export function parseStackLine(line: string): StackFrame | null {
  const trimmed = line.trim();

  if (!trimmed) {
    return null;
  }

  if (/^at\s/u.test(trimmed)) {
    return parseV8Line(trimmed);
  }

  const gecko = GECKO_FRAME.exec(trimmed);

  if (gecko) {
    return buildFrame(trimmed, gecko[1], gecko[2] ?? "");
  }

  return null;
}

/**
 * Parses the recorder's CDP console `stackTop` (`fn @ url:line:col`), whose positions are
 * 0-based CDP coordinates.
 */
export function parseCdpStackTop(stackTop: string): StackFrame | null {
  const trimmed = stackTop.trim().slice(0, MAX_LINE_CHARS);
  const separator = trimmed.indexOf(CDP_STACK_TOP_SEPARATOR);

  if (separator < 0) {
    return null;
  }

  const frame = buildFrame(
    trimmed,
    trimmed.slice(0, separator),
    trimmed.slice(separator + CDP_STACK_TOP_SEPARATOR.length)
  );

  return frame ? { ...frame, line: frame.line + 1, column: frame.column + 1 } : null;
}

/** Normalizes a frame URL for lookups: query string and fragment are dropped. */
export function stripFrameUrl(url: string): string {
  const cut = url.search(/[?#]/u);
  return cut >= 0 ? url.slice(0, cut) : url;
}

// V8: `at fn (url:1:2)`, `at url:1:2`, `at async fn (url:1:2)`, `at new Foo (url:1:2)`.
function parseV8Line(line: string): StackFrame | null {
  const body = line
    .replace(/^at\s+/u, "")
    .replace(/^async\s+/u, "")
    .replace(/^new\s+/u, "");
  const open = body.endsWith(")") ? findOpeningParen(body) : -1;

  if (open > 0) {
    return buildFrame(line, body.slice(0, open), body.slice(open + 1, -1));
  }

  return buildFrame(line, undefined, body);
}

/** Index of the `(` matching the final `)`, scanning backwards; -1 when unbalanced. */
function findOpeningParen(text: string): number {
  let depth = 0;

  for (let index = text.length - 1; index >= 0; index -= 1) {
    const char = text[index];

    if (char === ")") {
      depth += 1;
    } else if (char === "(") {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function buildFrame(
  raw: string,
  functionName: string | undefined,
  location: string
): StackFrame | null {
  // `eval at fn (url:1:2), <anonymous>:3:4` points into eval'd code, which has no source map.
  if (location.startsWith("eval at ") || location.includes("<anonymous>")) {
    return null;
  }

  const trimmed = location.trim();
  const match = LOCATION_SUFFIX.exec(trimmed);
  const url = match ? trimmed.slice(0, match.index) : "";

  if (!match || !url) {
    return null;
  }

  const line = Number(match[1]);
  const column = Number(match[2]);

  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column)) {
    return null;
  }

  const name = functionName?.trim();

  return {
    ...(name ? { functionName: name } : {}),
    url,
    line,
    column,
    raw
  };
}
