import { CONSOLE_FULL_ENTRY_MAX_CHARS, CONSOLE_FULL_STACK_MAX_FRAMES } from "@webblackbox/protocol";

/** Console arguments kept per entry under `console: allow` (the recorder's full shape keeps 64). */
export const FULL_CONSOLE_MAX_ARGS = 64;

/**
 * Frames above the page caller in a `new Error()` stack taken by {@link captureCallerStack}: the
 * helper itself and the console wrapper that calls it. Used only without `Error.captureStackTrace`.
 */
const FALLBACK_HOOK_FRAMES = 2;
const V8_FRAME_PREFIX = "at ";

/**
 * Text limits of one console entry under `console: allow`, the same rule the recorder applies to
 * full-detail entries: every argument string draws from one shared budget, the text has its own cap.
 */
export type ConsoleTextBudget = {
  /** Keeps what is left of the shared budget of `value`. */
  take: (value: string) => string;
  /** Cuts `value` to the per-entry ceiling, outside the shared budget. */
  cutText: (value: string) => string;
  isTruncated: () => boolean;
};

type StackApi = {
  stackTraceLimit?: unknown;
  captureStackTrace?: unknown;
};

type CaptureStackTrace = (target: object, boundary?: (...args: never[]) => unknown) => void;

export function createConsoleTextBudget(): ConsoleTextBudget {
  let remaining = CONSOLE_FULL_ENTRY_MAX_CHARS;
  let truncated = false;

  return {
    take: (value) => {
      const kept = value.slice(0, Math.max(0, remaining));
      remaining -= kept.length;
      truncated ||= kept.length < value.length;
      return kept;
    },
    cutText: (value) => {
      truncated ||= value.length > CONSOLE_FULL_ENTRY_MAX_CHARS;
      return value.slice(0, CONSOLE_FULL_ENTRY_MAX_CHARS);
    },
    isTruncated: () => truncated
  };
}

/**
 * The call stack of the code that called `boundary` (the hook's console wrapper), as V8
 * `Error.stack` frame lines without the hook's own frames, at most
 * {@link CONSOLE_FULL_STACK_MAX_FRAMES} deep. `Error.stackTraceLimit` is raised only for this one
 * capture and restored right after, so the page never sees a changed limit.
 */
export function captureCallerStack(boundary: (...args: never[]) => unknown): string | undefined {
  const stackApi = Error as unknown as StackApi;
  const previousLimit = stackApi.stackTraceLimit;
  const canRaiseLimit = typeof previousLimit === "number";

  try {
    if (canRaiseLimit) {
      trySetStackTraceLimit(stackApi, CONSOLE_FULL_STACK_MAX_FRAMES + FALLBACK_HOOK_FRAMES);
    }

    if (typeof stackApi.captureStackTrace === "function") {
      const holder: { stack?: unknown } = {};
      (stackApi.captureStackTrace as CaptureStackTrace)(holder, boundary);
      return formatStackFrames(holder.stack, 0);
    }

    return formatStackFrames(new Error().stack, FALLBACK_HOOK_FRAMES);
  } catch {
    return undefined;
  } finally {
    if (canRaiseLimit) {
      trySetStackTraceLimit(stackApi, previousLimit);
    }
  }
}

/** The top frame of a {@link captureCallerStack} stack, trimmed. */
export function readTopFrame(stack: string | undefined): string | undefined {
  return stack?.split("\n", 1)[0]?.trim() || undefined;
}

function formatStackFrames(stack: unknown, skipFrames: number): string | undefined {
  // A page-defined `Error.prepareStackTrace` may return anything.
  if (typeof stack !== "string") {
    return undefined;
  }

  const lines = stack.split("\n").filter((line) => line.trim().length > 0);
  // V8 puts a message header above `    at` frames; SpiderMonkey and JavaScriptCore list frames only.
  const isV8 = lines.some((line) => line.trimStart().startsWith(V8_FRAME_PREFIX));
  const frames = (
    isV8 ? lines.filter((line) => line.trimStart().startsWith(V8_FRAME_PREFIX)) : lines
  ).slice(skipFrames, skipFrames + CONSOLE_FULL_STACK_MAX_FRAMES);

  return frames.length > 0 ? frames.join("\n").slice(0, CONSOLE_FULL_ENTRY_MAX_CHARS) : undefined;
}

function trySetStackTraceLimit(stackApi: StackApi, value: unknown): void {
  try {
    stackApi.stackTraceLimit = value;
  } catch {
    // A frozen `Error` (SES lockdown and the like) keeps the page's limit.
  }
}
