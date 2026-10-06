/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONSOLE_FULL_ENTRY_MAX_CHARS,
  DEFAULT_CAPTURE_POLICY,
  type CapturePolicy
} from "@webblackbox/protocol";

import {
  INJECTED_MESSAGE_SOURCE,
  type InjectedCaptureWindowMessage,
  installInjectedLiteCaptureHooks
} from "./injected-hooks.js";

type CapturedEvent = {
  rawType: string;
  payload: Record<string, unknown>;
};

type ConsolePolicy = CapturePolicy["categories"]["console"];

/** Matches a frame of the hook module itself (not of this test file). */
const HOOK_FRAME_PATTERN = /injected-hooks\.ts/;
const LONG_LINE_CHARS = 7_000;
const DEEP_STACK_DEPTH = 15;

let flagCounter = 0;

function createPolicy(console: ConsolePolicy): CapturePolicy {
  return {
    ...DEFAULT_CAPTURE_POLICY,
    mode: "debug",
    categories: {
      ...DEFAULT_CAPTURE_POLICY.categories,
      console
    }
  };
}

function install(console: ConsolePolicy): void {
  flagCounter += 1;
  installInjectedLiteCaptureHooks({
    flag: `__WB_TEST_CONSOLE_FULL_TEXT_${flagCounter}__`,
    capturePolicy: createPolicy(console)
  });
}

// Hooks deliver events through two 0 ms timers: their emit flush, then jsdom's postMessage
// dispatch. Waiting a fixed number of 0 ms turns keeps that FIFO order however late the event loop
// runs, where a fixed sleep (e.g. 10 ms) can expire in the same pass as the flush under load.
const SETTLE_TURNS = 4;

async function settle(): Promise<void> {
  for (let turn = 0; turn < SETTLE_TURNS; turn += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

function createLongText(length: number): string {
  const unit = "lobby state segment ";
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

/** Logs `text` with console.error from a call chain `depth` frames below this function. */
function logErrorFromDepth(depth: number, text: string): void {
  if (depth > 0) {
    logErrorFromDepth(depth - 1, text);
    return;
  }

  console.error(text);
}

function readStackFrames(stack: unknown): string[] {
  expect(typeof stack).toBe("string");
  return (stack as string).split("\n");
}

describe("injected console hook text and stack", () => {
  const captured: CapturedEvent[] = [];

  const lastEvent = (rawType: string): Record<string, unknown> => {
    const event = captured.filter((entry) => entry.rawType === rawType).at(-1);
    expect(event).toBeDefined();
    return event!.payload;
  };

  beforeEach(() => {
    captured.length = 0;

    // Spied so that restoreAllMocks also removes the hook wrappers installed on top of them.
    for (const method of ["log", "info", "warn", "error", "trace"] as const) {
      vi.spyOn(console, method).mockImplementation(() => undefined);
    }

    vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
      const row = message as InjectedCaptureWindowMessage;

      if (row?.source !== INJECTED_MESSAGE_SOURCE) {
        return;
      }

      if (row.kind === "capture-event") {
        captured.push({ rawType: row.rawType, payload: row.payload });
        return;
      }

      if (row.kind === "capture-events" && Array.isArray(row.events)) {
        captured.push(
          ...row.events.map((event) => ({ rawType: event.rawType, payload: event.payload }))
        );
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("under console: allow", () => {
    it("keeps a console line longer than 6 000 characters whole", async () => {
      install("allow");
      const text = createLongText(LONG_LINE_CHARS);

      console.log(text);
      await settle();

      const payload = lastEvent("console");
      expect(payload.text).toBe(text);
      expect((payload.args as unknown[])[0]).toBe(text);
      expect(payload.truncated).toBeUndefined();
      expect(payload.redacted).toBe(false);
    });

    it("keeps long strings nested in logged objects whole", async () => {
      install("allow");
      const detail = createLongText(5_000);

      console.log("state", { detail });
      await settle();

      const payload = lastEvent("console");
      expect((payload.args as Array<Record<string, unknown>>)[1]?.detail).toBe(detail);
      expect(String(payload.text)).toContain(detail);
    });

    it("caps one entry at the shared full-detail ceiling and flags it", async () => {
      install("allow");

      console.log(createLongText(CONSOLE_FULL_ENTRY_MAX_CHARS + 500), createLongText(800));
      await settle();

      const payload = lastEvent("console");
      const args = payload.args as string[];
      expect(args[0]).toHaveLength(CONSOLE_FULL_ENTRY_MAX_CHARS);
      expect(args[1]).toBe("");
      expect(payload.text).toHaveLength(CONSOLE_FULL_ENTRY_MAX_CHARS);
      expect(payload.truncated).toBe(true);
    });

    it("records the whole call stack without the hook's own frames", async () => {
      install("allow");
      const limitBefore = Error.stackTraceLimit;

      logErrorFromDepth(DEEP_STACK_DEPTH, "deep failure");
      await settle();

      const payload = lastEvent("console");
      const frames = readStackFrames(payload.stack);
      expect(Error.stackTraceLimit).toBe(limitBefore);
      expect(frames.every((frame) => frame.startsWith("    at "))).toBe(true);
      expect(frames.some((frame) => HOOK_FRAME_PATTERN.test(frame))).toBe(false);
      expect(frames[0]).toContain("logErrorFromDepth");
      expect(frames.filter((frame) => frame.includes("logErrorFromDepth"))).toHaveLength(
        DEEP_STACK_DEPTH + 1
      );
      expect(payload.stackTop).toBe(frames[0]?.trim());
    });

    it("goes past a low page Error.stackTraceLimit and restores it", async () => {
      install("allow");
      const limitBefore = Error.stackTraceLimit;
      Error.stackTraceLimit = 3;

      try {
        logErrorFromDepth(DEEP_STACK_DEPTH, "deep failure");
        expect(Error.stackTraceLimit).toBe(3);
      } finally {
        Error.stackTraceLimit = limitBefore;
      }

      await settle();

      const frames = readStackFrames(lastEvent("console").stack);
      expect(frames.filter((frame) => frame.includes("logErrorFromDepth"))).toHaveLength(
        DEEP_STACK_DEPTH + 1
      );
    });

    it("drops the hook frames without Error.captureStackTrace", async () => {
      install("allow");
      const errorCtor = Error as { captureStackTrace?: unknown };
      const captureStackTrace = errorCtor.captureStackTrace;
      errorCtor.captureStackTrace = undefined;

      try {
        logErrorFromDepth(2, "fallback failure");
      } finally {
        errorCtor.captureStackTrace = captureStackTrace;
      }

      await settle();

      const frames = readStackFrames(lastEvent("console").stack);
      expect(frames.some((frame) => HOOK_FRAME_PATTERN.test(frame))).toBe(false);
      expect(frames[0]).toContain("logErrorFromDepth");
    });

    it("does not recurse when a page Error.prepareStackTrace logs", async () => {
      install("allow");
      const stackApi = Error as { prepareStackTrace?: unknown };
      const previous = stackApi.prepareStackTrace;
      stackApi.prepareStackTrace = (error: Error, frames: unknown[]) => {
        console.warn("formatting stack");
        return `${error.name}\n${frames.map(() => "    at pageFrame (page.js:1:1)").join("\n")}`;
      };

      try {
        expect(() => logErrorFromDepth(2, "nested failure")).not.toThrow();
      } finally {
        stackApi.prepareStackTrace = previous;
      }

      await settle();

      const consoleEvents = captured.filter((entry) => entry.rawType === "console");
      const nested = consoleEvents.find((entry) => entry.payload.method === "warn");
      const outer = consoleEvents.find((entry) => entry.payload.method === "error");
      expect(nested?.payload.stack).toBeUndefined();
      expect(readStackFrames(outer?.payload.stack)[0]).toContain("pageFrame");
    });

    it("records no stack for plain console.log", async () => {
      install("allow");

      console.log("plain");
      await settle();

      const payload = lastEvent("console");
      expect(payload.stack).toBeUndefined();
      expect(payload.stackTop).toBeUndefined();
    });

    it("keeps a whole uncaught error stack and message", async () => {
      install("allow");
      const limitBefore = Error.stackTraceLimit;
      Error.stackTraceLimit = 50;
      let error: Error;

      try {
        error = createDeepError(30, createLongText(LONG_LINE_CHARS));
      } finally {
        Error.stackTraceLimit = limitBefore;
      }

      window.dispatchEvent(
        new ErrorEvent("error", { message: error.message, error, lineno: 1, colno: 1 })
      );
      await settle();

      const payload = lastEvent("pageError");
      expect(payload.message).toBe(error.message);
      expect(payload.stack).toBe(error.stack);
      expect(String(payload.stack).split("\n").length).toBeGreaterThan(30);
    });

    it("keeps a whole unhandled rejection reason", async () => {
      install("allow");
      const reason = createLongText(LONG_LINE_CHARS);

      window.dispatchEvent(createRejectionEvent(reason));
      await settle();

      expect(lastEvent("unhandledrejection").reason).toBe(reason);
    });
  });

  describe("under other policies (unchanged)", () => {
    it("emits no text, arguments or stack under metadata", async () => {
      install("metadata");

      logErrorFromDepth(DEEP_STACK_DEPTH, createLongText(LONG_LINE_CHARS));
      await settle();

      expect(lastEvent("console")).toEqual({
        source: "injected",
        method: "error",
        level: "error",
        redacted: true
      });
    });

    it("keeps the 600-character text and no full stack under sanitized", async () => {
      install("sanitized");

      logErrorFromDepth(DEEP_STACK_DEPTH, createLongText(LONG_LINE_CHARS));
      await settle();

      const payload = lastEvent("console");
      expect(payload.text).toHaveLength(600);
      expect(String(payload.text).endsWith("...")).toBe(true);
      expect((payload.args as string[])[0]).toHaveLength(1_200);
      expect(payload.stack).toBeUndefined();
      expect(payload.truncated).toBeUndefined();
      expect(payload.redacted).toBe(true);
    });

    it("keeps cutting unhandled rejection reasons under sanitized", async () => {
      install("sanitized");

      window.dispatchEvent(createRejectionEvent(createLongText(LONG_LINE_CHARS)));
      await settle();

      expect(lastEvent("unhandledrejection").reason).toHaveLength(1_200);
    });
  });
});

function createDeepError(depth: number, message: string): Error {
  if (depth > 0) {
    return createDeepError(depth - 1, message);
  }

  return new Error(message);
}

function createRejectionEvent(reason: unknown): Event {
  const event = new Event("unhandledrejection");
  Object.defineProperty(event, "reason", { value: reason });
  return event;
}
