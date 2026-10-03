import { describe, expect, it } from "vitest";

import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  type CapturePolicy,
  type RecorderConfig
} from "@webblackbox/protocol";

import { WebBlackboxRecorder } from "./recorder.js";

const EXCEPTION_MARKER = "stand-exception-marker-7f3a";
const REJECTION_MARKER = "stand-rejection-marker-91c2";
const CONSOLE_MARKER = "stand-console-marker-4d0e";
const SCRIPT_URL = "https://app.example.com/static/app.js?token=script-secret";
// Chrome prints the script URL in the stack; a query with a sensitive key would get the whole stack
// hashed by the generic redactor, so the stack text uses the bare path.
const SCRIPT_PATH = "https://app.example.com/static/app.js";

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

function ingestCdp(console: ConsolePolicy, rawType: string, payload: unknown) {
  const recorder = new WebBlackboxRecorder(createConfig(console));
  const event = recorder.ingest({
    source: "cdp",
    rawType,
    sid: "S-cdp-runtime",
    tabId: 1,
    t: 1_700_000_000_000,
    mono: 10,
    cdpSessionId: "cdp-session-1",
    payload
  }).event;

  expect(event).toBeDefined();
  return event!;
}

function ingestContent(console: ConsolePolicy, rawType: string, payload: unknown) {
  const recorder = new WebBlackboxRecorder(createConfig(console));
  const event = recorder.ingest({
    source: "content",
    rawType,
    sid: "S-content-runtime",
    tabId: 1,
    t: 1_700_000_000_000,
    mono: 10,
    payload
  }).event;

  expect(event).toBeDefined();
  return event!;
}

/** `Runtime.exceptionThrown` as Chrome sends it for `setTimeout(() => { throw new Error(...) })`. */
function createUncaughtError(): Record<string, unknown> {
  const description = `Error: ${EXCEPTION_MARKER}\n    at throwLater (${SCRIPT_PATH}:42:15)`;

  return {
    timestamp: 1_700_000_000_123.4,
    exceptionDetails: {
      exceptionId: 3,
      text: "Uncaught",
      lineNumber: 41,
      columnNumber: 14,
      scriptId: "77",
      url: SCRIPT_URL,
      stackTrace: {
        callFrames: [
          {
            functionName: "throwLater",
            scriptId: "77",
            url: SCRIPT_URL,
            lineNumber: 41,
            columnNumber: 14
          }
        ]
      },
      exception: {
        type: "object",
        subtype: "error",
        className: "Error",
        description,
        objectId: "-4211845116458127541.1.2",
        preview: {
          type: "object",
          subtype: "error",
          description,
          overflow: false,
          properties: [
            { name: "stack", type: "string", value: description },
            { name: "message", type: "string", value: EXCEPTION_MARKER }
          ]
        }
      },
      executionContextId: 1
    }
  };
}

/** `Runtime.exceptionThrown` for `Promise.reject(new Error(...))` left unhandled. */
function createUnhandledRejection(): Record<string, unknown> {
  const description = `Error: ${REJECTION_MARKER}\n    at rejectLater (${SCRIPT_PATH}:50:20)`;

  return {
    timestamp: 1_700_000_000_456.7,
    exceptionDetails: {
      exceptionId: 4,
      text: "Uncaught (in promise)",
      lineNumber: 49,
      columnNumber: 19,
      scriptId: "77",
      url: SCRIPT_URL,
      exception: {
        type: "object",
        subtype: "error",
        className: "Error",
        description,
        objectId: "-4211845116458127541.1.3"
      },
      executionContextId: 1
    }
  };
}

/** `Runtime.exceptionThrown` for `Promise.reject("...")` with a primitive reason. */
function createPrimitiveRejection(): Record<string, unknown> {
  return {
    timestamp: 1_700_000_000_789.1,
    exceptionDetails: {
      exceptionId: 5,
      text: "Uncaught (in promise)",
      lineNumber: 0,
      columnNumber: 0,
      exception: { type: "string", value: REJECTION_MARKER },
      executionContextId: 1
    }
  };
}

function createConsoleApiCalled(): Record<string, unknown> {
  return {
    type: "error",
    args: [
      { type: "string", value: `payment failed ${CONSOLE_MARKER}` },
      {
        type: "object",
        className: "Object",
        description: "Object",
        objectId: "-4211845116458127541.1.4",
        preview: {
          type: "object",
          description: "Object",
          overflow: false,
          properties: [{ name: "orderId", type: "string", value: CONSOLE_MARKER }]
        }
      }
    ],
    executionContextId: 1,
    timestamp: 1_700_000_000_999.5,
    stackTrace: {
      callFrames: [
        {
          functionName: "pay",
          scriptId: "77",
          url: SCRIPT_URL,
          lineNumber: 60,
          columnNumber: 8
        }
      ]
    }
  };
}

describe("CDP Runtime errors under the console policy", () => {
  describe("metadata (default)", () => {
    it("keeps an uncaught exception as text-less metadata, like lite", () => {
      const event = ingestCdp("metadata", "Runtime.exceptionThrown", createUncaughtError());
      const serialized = JSON.stringify(event);

      expect(event.type).toBe("error.exception");
      expect(event.data).toEqual({
        source: "cdp.runtime",
        filename: "https://app.example.com/static/app.js",
        lineno: 42,
        colno: 15,
        exceptionId: 3,
        timestamp: 1_700_000_000_123.4,
        messageRedacted: true,
        stackRedacted: true
      });
      expect(serialized).not.toContain(EXCEPTION_MARKER);
      expect(serialized).not.toContain("script-secret");
      expect(serialized).not.toContain("throwLater");
    });

    it("withholds unhandled rejection text and marks the rejection", () => {
      for (const payload of [createUnhandledRejection(), createPrimitiveRejection()]) {
        const event = ingestCdp("metadata", "Runtime.exceptionThrown", payload);
        const data = event.data as Record<string, unknown>;

        expect(event.type).toBe("error.exception");
        expect(data.rejection).toBe(true);
        expect(data.messageRedacted).toBe(true);
        expect(data.message).toBeUndefined();
        expect(data.stack).toBeUndefined();
        expect(JSON.stringify(event)).not.toContain(REJECTION_MARKER);
      }
    });

    it("turns console text into a privacy violation", () => {
      const event = ingestCdp("metadata", "Runtime.consoleAPICalled", createConsoleApiCalled());

      expect(event.type).toBe("privacy.violation");
      expect(JSON.stringify(event)).not.toContain(CONSOLE_MARKER);
    });

    it("strips exception text that reaches the recorder from content scripts", () => {
      const event = ingestContent("metadata", "pageError", {
        message: `Uncaught Error: ${EXCEPTION_MARKER}`,
        filename: "https://app.example.com/static/app.js",
        lineno: 42,
        colno: 15,
        stack: `Error: ${EXCEPTION_MARKER}\n    at throwLater (app.js:42:15)`
      });
      const rejection = ingestContent("metadata", "unhandledrejection", {
        reason: { message: REJECTION_MARKER }
      });

      expect(event.type).toBe("error.exception");
      expect(event.data).toEqual({
        filename: "https://app.example.com/static/app.js",
        lineno: 42,
        colno: 15,
        messageRedacted: true,
        stackRedacted: true
      });
      expect(rejection.type).toBe("error.unhandledrejection");
      expect(rejection.data).toEqual({ reasonRedacted: true });
    });

    it("leaves lite's already text-less payloads unchanged", () => {
      const litePayload = {
        filename: "https://app.example.com/static/app.js",
        lineno: 42,
        colno: 15,
        messageRedacted: true,
        stackRedacted: true
      };

      expect(ingestContent("metadata", "pageError", litePayload).data).toEqual(litePayload);
      expect(
        ingestContent("metadata", "unhandledrejection", { reasonRedacted: true }).data
      ).toEqual({ reasonRedacted: true });
    });
  });

  describe("allow", () => {
    it("keeps the exception message, name and stack", () => {
      const event = ingestCdp("allow", "Runtime.exceptionThrown", createUncaughtError());
      const data = event.data as Record<string, unknown>;

      expect(event.type).toBe("error.exception");
      expect(data.message).toBe(`Error: ${EXCEPTION_MARKER}`);
      expect(data.name).toBe("Error");
      expect(data.stack).toContain("at throwLater");
      expect(data.filename).toBe("https://app.example.com/static/app.js");
      expect(data.rejection).toBeUndefined();
      expect(JSON.stringify(data)).not.toContain("objectId");
      expect(JSON.stringify(data)).not.toContain("preview");
    });

    it("keeps rejection reasons, including primitive ones", () => {
      const error = ingestCdp("allow", "Runtime.exceptionThrown", createUnhandledRejection());
      const primitive = ingestCdp("allow", "Runtime.exceptionThrown", createPrimitiveRejection());

      expect((error.data as Record<string, unknown>).message).toBe(`Error: ${REJECTION_MARKER}`);
      expect((error.data as Record<string, unknown>).rejection).toBe(true);
      expect((primitive.data as Record<string, unknown>).message).toBe(REJECTION_MARKER);
    });

    it("builds a stack from call frames when the description has none", () => {
      const payload = createUncaughtError();
      const details = payload.exceptionDetails as Record<string, unknown>;
      const event = ingestCdp("allow", "Runtime.exceptionThrown", {
        ...payload,
        exceptionDetails: {
          ...details,
          exception: { type: "string", value: EXCEPTION_MARKER }
        }
      });
      const data = event.data as Record<string, unknown>;

      expect(data.message).toBe(EXCEPTION_MARKER);
      expect(data.stack).toBe("    at throwLater (https://app.example.com/static/app.js:42:15)");
    });

    it("keeps console text", () => {
      const event = ingestCdp("allow", "Runtime.consoleAPICalled", createConsoleApiCalled());

      expect(event.type).toBe("console.entry");
      expect((event.data as { text?: string }).text).toContain(CONSOLE_MARKER);
    });
  });

  it("drops errors entirely when the console category is off", () => {
    const event = ingestCdp("off", "Runtime.exceptionThrown", createUncaughtError());

    expect(event.type).toBe("privacy.violation");
    expect(JSON.stringify(event)).not.toContain(EXCEPTION_MARKER);
  });
});
