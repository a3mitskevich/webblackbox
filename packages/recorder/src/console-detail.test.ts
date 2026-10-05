import { describe, expect, it } from "vitest";

import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  type CapturePolicy,
  type RecorderConfig
} from "@webblackbox/protocol";

import { MAX_CONSOLE_ENTRY_CHARS } from "./console-normalizer.js";
import { WebBlackboxRecorder } from "./recorder.js";

const SCRIPT_URL = "https://app.example.com/static/app.min.js";
const V8_FRAME_PATTERN = /^ {4}at (\S+) \((\S+):(\d+):(\d+)\)$/;

type ConsolePolicy = CapturePolicy["categories"]["console"];

function createConfig(console: ConsolePolicy): RecorderConfig {
  return {
    ...DEFAULT_RECORDER_CONFIG,
    mode: "full",
    capturePolicy: {
      ...DEFAULT_CAPTURE_POLICY,
      categories: {
        ...DEFAULT_CAPTURE_POLICY.categories,
        console
      }
    }
  };
}

function ingest(
  console: ConsolePolicy,
  source: "cdp" | "content",
  rawType: string,
  payload: unknown
): { type: string; data: Record<string, unknown> } {
  const recorder = new WebBlackboxRecorder(createConfig(console));
  const event = recorder.ingest({
    source,
    rawType,
    sid: "S-console-detail",
    tabId: 1,
    t: 1_700_000_000_000,
    mono: 10,
    payload
  }).event;

  expect(event).toBeDefined();
  return { type: event!.type, data: event!.data as Record<string, unknown> };
}

/** A minified-bundle call chain `depth` frames deep, as CDP reports it (0-based positions). */
function createCallFrames(depth: number): Record<string, unknown>[] {
  return Array.from({ length: depth }, (_, index) => ({
    functionName: index % 5 === 0 ? "" : `fn${index}`,
    scriptId: "42",
    url: SCRIPT_URL,
    lineNumber: 0,
    columnNumber: 1_000 + index
  }));
}

/** Readable filler (no tokens, keys or digits runs the generic redactor would hash). */
function createLongText(length: number): string {
  const unit = "game round state payload segment ";
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

/** `Runtime.consoleAPICalled` for `console.<type>(text)` with a captured stack. */
function createConsoleApiCall(type: string, text: string, depth: number): Record<string, unknown> {
  return {
    type,
    args: [{ type: "string", value: text }],
    executionContextId: 1,
    timestamp: 1_700_000_000_100,
    stackTrace: { callFrames: createCallFrames(depth) }
  };
}

function readStackLines(stack: unknown): string[] {
  expect(typeof stack).toBe("string");
  return (stack as string).split("\n");
}

describe("console text and stack under console: allow", () => {
  it("keeps a 5 000-char console.error argument and the full 40-frame stack", () => {
    const text = createLongText(5_000);
    const { type, data } = ingest(
      "allow",
      "cdp",
      "Runtime.consoleAPICalled",
      createConsoleApiCall("error", text, 40)
    );

    expect(type).toBe("console.entry");
    expect(data.text).toBe(text);
    expect(data.args).toEqual([text]);
    expect(data.truncated).toBeUndefined();
    expect(data.stackTop).toBe(`(anonymous) @ ${SCRIPT_URL}:0:1000`);

    const lines = readStackLines(data.stack);
    expect(lines).toHaveLength(40);
    expect(lines.every((line) => V8_FRAME_PATTERN.test(line))).toBe(true);
    // 1-based like Error.stack, so the source-map symbolicator reads it like a page error stack.
    expect(lines[0]).toBe(`    at (anonymous) (${SCRIPT_URL}:1:1001)`);
    expect(lines[39]).toBe(`    at fn39 (${SCRIPT_URL}:1:1040)`);
  });

  it("caps one entry at 64 KiB and flags it", () => {
    const text = createLongText(100_000);
    const { data } = ingest(
      "allow",
      "cdp",
      "Runtime.consoleAPICalled",
      createConsoleApiCall("warning", `${text}`, 2)
    );

    expect(data.truncated).toBe(true);
    expect((data.text as string).length).toBe(MAX_CONSOLE_ENTRY_CHARS);
    expect(text.startsWith(data.text as string)).toBe(true);
    expect((data.args as string[])[0]).toHaveLength(MAX_CONSOLE_ENTRY_CHARS);
    expect(readStackLines(data.stack)).toHaveLength(2);
  });

  it("shares the 64 KiB budget across arguments", () => {
    const part = createLongText(40_000);
    const { data } = ingest("allow", "cdp", "Runtime.consoleAPICalled", {
      type: "log",
      args: [
        { type: "string", value: part },
        { type: "string", value: part },
        { type: "number", value: 7, description: "7" }
      ],
      timestamp: 1
    });
    const args = data.args as unknown[];

    expect(data.truncated).toBe(true);
    expect(args[0]).toBe(part);
    expect((args[1] as string).length).toBe(MAX_CONSOLE_ENTRY_CHARS - part.length);
    expect(args[2]).toBe(7);
  });

  it("keeps only the top frame for plain console.log", () => {
    const { data } = ingest(
      "allow",
      "cdp",
      "Runtime.consoleAPICalled",
      createConsoleApiCall("log", "hello", 12)
    );

    expect(data.text).toBe("hello");
    expect(data.stack).toBeUndefined();
    expect(data.stackTop).toBe(`(anonymous) @ ${SCRIPT_URL}:0:1000`);
  });

  it("keeps the full stack for console.assert and console.trace", () => {
    for (const type of ["assert", "trace"]) {
      const { data } = ingest(
        "allow",
        "cdp",
        "Runtime.consoleAPICalled",
        createConsoleApiCall(type, "checkpoint", 8)
      );

      expect(readStackLines(data.stack)).toHaveLength(8);
    }
  });

  it("keeps a logged Error description (message and stack) in full", () => {
    const description = `TypeError: ${createLongText(2_000)}\n${Array.from(
      { length: 20 },
      (_, index) => `    at fn${index} (${SCRIPT_URL}:1:${index + 1})`
    ).join("\n")}`;
    const { data } = ingest("allow", "cdp", "Runtime.consoleAPICalled", {
      type: "error",
      args: [
        { type: "string", value: "request failed" },
        { type: "object", subtype: "error", className: "TypeError", description }
      ],
      timestamp: 1
    });

    expect(data.args).toEqual(["request failed", description]);
    expect(data.text).toBe(`request failed ${description}`);
  });

  it("keeps long Log.entryAdded errors with their stack", () => {
    const text = createLongText(3_000);
    const { data } = ingest("allow", "cdp", "Log.entryAdded", {
      entry: {
        source: "javascript",
        level: "error",
        text,
        timestamp: 1,
        url: SCRIPT_URL,
        lineNumber: 0,
        stackTrace: { callFrames: createCallFrames(15) }
      }
    });

    expect(data.text).toBe(text);
    expect(data.args).toEqual([text]);
    expect(readStackLines(data.stack)).toHaveLength(15);
  });

  it("does not cut page-hook console arguments to 260 characters", () => {
    const text = createLongText(4_000);
    const { data } = ingest("allow", "content", "console", {
      source: "injected",
      method: "error",
      level: "error",
      args: [text, { detail: text }]
    });

    expect((data.args as unknown[])[0]).toBe(text);
    expect((data.args as Array<Record<string, unknown>>)[1]?.detail).toBe(text);
  });

  it("keeps the page-hook call stack and its truncation flag", () => {
    const stack = Array.from(
      { length: 30 },
      (_, index) => `    at fn${index} (${SCRIPT_URL}:1:${index + 1})`
    ).join("\n");
    const { data } = ingest("allow", "content", "console", {
      source: "injected",
      method: "error",
      level: "error",
      args: ["boom"],
      text: "boom",
      stackTop: `at fn0 (${SCRIPT_URL}:1:1)`,
      stack,
      truncated: true
    });

    expect(data.stack).toBe(stack);
    expect(data.stackTop).toBe(`at fn0 (${SCRIPT_URL}:1:1)`);
    expect(data.truncated).toBe(true);
  });

  it("holds a page-hook stack to the frame ceiling", () => {
    const stack = Array.from({ length: 260 }, (_, index) => `    at fn${index} (app.js:1:1)`).join(
      "\n"
    );
    const { data } = ingest("allow", "content", "console", {
      source: "injected",
      method: "error",
      level: "error",
      text: "boom",
      stack
    });

    expect(readStackLines(data.stack)).toHaveLength(200);
  });
});

describe("console text under other policies stays compact", () => {
  it("cuts text to the legacy limits and keeps only stackTop under sanitized", () => {
    const text = createLongText(5_000);
    const { data } = ingest(
      "sanitized",
      "cdp",
      "Runtime.consoleAPICalled",
      createConsoleApiCall("error", text, 40)
    );

    expect((data.args as string[])[0]).toHaveLength(260);
    expect((data.args as string[])[0]?.endsWith("...")).toBe(true);
    expect(data.stack).toBeUndefined();
    expect(data.truncated).toBeUndefined();
    expect(data.stackTop).toBe(`(anonymous) @ ${SCRIPT_URL}:0:1000`);
  });

  it("still turns console text into a privacy violation under metadata", () => {
    const { type } = ingest(
      "metadata",
      "cdp",
      "Runtime.consoleAPICalled",
      createConsoleApiCall("error", createLongText(5_000), 40)
    );

    expect(type).toBe("privacy.violation");
  });

  it("drops a page-hook stack and truncation flag under sanitized", () => {
    const { data } = ingest("sanitized", "content", "console", {
      source: "injected",
      method: "error",
      level: "error",
      text: "boom",
      stack: `    at fn0 (${SCRIPT_URL}:1:1)`,
      truncated: true
    });

    expect(data.stack).toBeUndefined();
    expect(data.truncated).toBeUndefined();
  });
});

describe("CDP exceptions under console: allow", () => {
  function createDeepException(messageLength: number, depth: number): Record<string, unknown> {
    const message = createLongText(messageLength);
    // V8 cuts Error.stack at Error.stackTraceLimit (10); CDP call frames go deeper.
    const description = `Error: ${message}\n${createCallFrames(Math.min(depth, 10))
      .map(
        (frame) =>
          `    at ${String(frame.functionName) || "(anonymous)"} (${SCRIPT_URL}:1:${Number(frame.columnNumber) + 1})`
      )
      .join("\n")}`;

    return {
      timestamp: 1,
      exceptionDetails: {
        exceptionId: 9,
        text: "Uncaught",
        lineNumber: 0,
        columnNumber: 1_000,
        url: SCRIPT_URL,
        stackTrace: { callFrames: createCallFrames(depth) },
        exception: { type: "object", subtype: "error", className: "Error", description }
      }
    };
  }

  it("keeps the whole message and every CDP call frame", () => {
    const { type, data } = ingest(
      "allow",
      "cdp",
      "Runtime.exceptionThrown",
      createDeepException(5_000, 60)
    );
    const lines = readStackLines(data.stack);

    expect(type).toBe("error.exception");
    expect(data.message).toBe(`Error: ${createLongText(5_000)}`);
    expect(lines[0]).toBe(data.message);
    expect(lines.slice(1)).toHaveLength(60);
    expect(lines.slice(1).every((line) => V8_FRAME_PATTERN.test(line))).toBe(true);
  });

  it("keeps the description stack when CDP has no deeper call frames", () => {
    const payload = createDeepException(100, 3);
    const description = (
      (payload.exceptionDetails as Record<string, unknown>).exception as Record<string, unknown>
    ).description;
    const { data } = ingest("allow", "cdp", "Runtime.exceptionThrown", payload);

    expect(data.stack).toBe(description);
  });

  it("keeps the legacy caps under sanitized", () => {
    const { data } = ingest(
      "sanitized",
      "cdp",
      "Runtime.exceptionThrown",
      createDeepException(5_000, 60)
    );

    expect((data.message as string).length).toBe(2_000);
    expect(readStackLines(data.stack).length).toBeLessThanOrEqual(11);
  });
});

describe("CDP console object arguments", () => {
  function consoleObjectEvent(console: ConsolePolicy) {
    const recorder = new WebBlackboxRecorder(createConfig(console));

    return recorder.ingest({
      source: "cdp",
      rawType: "Runtime.consoleAPICalled",
      sid: "S-console-objects",
      tabId: 1,
      t: 1,
      mono: 1,
      payload: {
        type: "log",
        args: [
          { type: "string", value: "login attempt" },
          {
            type: "object",
            className: "Object",
            description: "Object",
            preview: {
              type: "object",
              description: "Object",
              overflow: false,
              properties: [
                { name: "user", type: "string", value: "ada" },
                { name: "attempt", type: "number", value: "3" },
                {
                  name: "tags",
                  type: "object",
                  subtype: "array",
                  value: "Array(2)",
                  valuePreview: {
                    type: "object",
                    subtype: "array",
                    overflow: true,
                    properties: [{ name: "0", type: "string", value: "beta" }]
                  }
                }
              ]
            }
          }
        ]
      }
    }).event?.data as { args: unknown[]; text: string } | undefined;
  }

  it("keeps the object CDP previews under console: allow", () => {
    const data = consoleObjectEvent("allow");

    expect(data?.args[1]).toEqual({ user: "ada", attempt: 3, tags: ["beta", "…"] });
    expect(data?.text).toContain("ada");
  });

  it("keeps the short description in the compact detail", () => {
    expect(consoleObjectEvent("sanitized")?.args[1]).toBe("Object");
  });
});
