import { describe, expect, it } from "vitest";

import type { CdpReadOutcome } from "./full-body-capture.js";
import type { BodyCaptureRule } from "./body-capture-utils.js";
import {
  BodyHeadStream,
  FULL_BODY_MAX_ACTIVE_STREAMS,
  FULL_BODY_STREAM_MAX_RESPONSE_BYTES,
  LargeBodyStreams,
  type StreamStartRead
} from "./full-body-stream.js";

function base64(text: string): string {
  return Buffer.from(text).toString("base64");
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function createStream(maxBytes: number): {
  stream: BodyHeadStream;
  start: (outcome: CdpReadOutcome<StreamStartRead>) => void;
} {
  let start: (outcome: CdpReadOutcome<StreamStartRead>) => void = () => undefined;
  const started = new Promise<CdpReadOutcome<StreamStartRead>>((resolve) => {
    start = resolve;
  });

  return { stream: new BodyHeadStream(maxBytes, started, decodeBase64), start };
}

async function headText(stream: BodyHeadStream): Promise<unknown> {
  const result = await stream.result();
  return result.ok
    ? { text: new TextDecoder().decode(result.head), totalBytes: result.totalBytes }
    : result;
}

describe("BodyHeadStream", () => {
  it("keeps the buffered bytes, then the streamed ones, up to the limit", async () => {
    const { stream, start } = createStream(8);

    stream.onData(3, undefined);
    start({ ok: true, value: { bufferedData: base64("abc") } });
    await stream.started;
    stream.onData(4, base64("defg"));
    stream.onData(4, base64("hijk"));

    await expect(headText(stream)).resolves.toEqual({ text: "abcdefgh", totalBytes: 11 });
  });

  it("keeps chunks that arrive before the start result after the buffered bytes", async () => {
    const { stream, start } = createStream(16);

    stream.onData(2, base64("cd"));
    start({ ok: true, value: { bufferedData: base64("ab") } });

    // At least the kept bytes, even when their dataReceived events were not seen.
    await expect(headText(stream)).resolves.toEqual({ text: "abcd", totalBytes: 4 });
  });

  it("fails when the buffer lost bytes received before streaming began", async () => {
    const { stream, start } = createStream(16);

    stream.onData(10, undefined);
    start({ ok: true, value: { bufferedData: base64("short") } });
    stream.onData(3, base64("xyz"));

    await expect(stream.result()).resolves.toEqual({
      ok: false,
      error:
        "the browser dropped the start of the body before streaming began (5 of 10 bytes buffered)"
    });
  });

  it("fails with the CDP error, a rejected start or unreadable data", async () => {
    const failed = createStream(16);
    failed.start({ ok: false, error: "No resource with given identifier" });
    await expect(failed.stream.result()).resolves.toEqual({
      ok: false,
      error: "No resource with given identifier"
    });

    const rejected = new BodyHeadStream(16, Promise.reject(new Error("detached")), decodeBase64);
    await expect(rejected.result()).resolves.toEqual({ ok: false, error: "detached" });

    const unreadable = new BodyHeadStream(
      16,
      Promise.resolve({ ok: true, value: { bufferedData: "x" } }),
      () => {
        throw new Error("bad base64");
      }
    );
    await expect(unreadable.result()).resolves.toEqual({
      ok: false,
      error: "unreadable stream data: bad base64"
    });
  });

  it("counts every received byte but ignores negative or missing lengths", async () => {
    const { stream, start } = createStream(4);

    start({ ok: true, value: {} });
    await stream.started;
    stream.onData(Number.NaN, base64("ab"));
    stream.onData(-5, base64("cd"));
    stream.onData(6, base64("efghij"));

    await expect(headText(stream)).resolves.toEqual({ text: "abcd", totalBytes: 6 });
  });
});

describe("BodyHeadStream limits", () => {
  it("fails once the response passes the streaming limit", async () => {
    const { stream, start } = createStream(4);

    start({ ok: true, value: { bufferedData: base64("ab") } });
    await stream.started;
    stream.onData(FULL_BODY_STREAM_MAX_RESPONSE_BYTES + 1, base64("cd"));

    await expect(stream.result()).resolves.toEqual({
      ok: false,
      error: `over the ${FULL_BODY_STREAM_MAX_RESPONSE_BYTES} byte limit for streaming its start`
    });
  });
});

describe("LargeBodyStreams", () => {
  const RULE: BodyCaptureRule = { enabled: true, maxBytes: 4, mimeAllowlist: [] };
  const started: string[] = [];
  const start = (requestId: string): Promise<CdpReadOutcome<StreamStartRead>> => {
    started.push(requestId);
    return Promise.resolve({ ok: true, value: {} });
  };

  it("frees a stream slot when a streamed response is forgotten", () => {
    started.length = 0;
    const streams = new LargeBodyStreams(start, decodeBase64, 100);

    for (let index = 0; index <= FULL_BODY_MAX_ACTIVE_STREAMS; index += 1) {
      streams.track(`k${index}`, { requestId: `r${index}`, contentLength: 100 }, RULE, 8);
    }

    expect(started).toHaveLength(FULL_BODY_MAX_ACTIVE_STREAMS);
    expect(streams.take(`k${FULL_BODY_MAX_ACTIVE_STREAMS}`)?.notStreamed).toBe(
      "too many large responses were streaming at once"
    );

    streams.forget("k0");
    streams.track("late", { requestId: "late", contentLength: 100 }, RULE, 8);
    expect(started.at(-1)).toBe("late");
  });

  it("forgets the oldest responses past its bound", () => {
    const streams = new LargeBodyStreams(undefined, decodeBase64, 2);

    streams.track("a", { requestId: "a" }, RULE, 8);
    streams.track("b", { requestId: "b" }, RULE, 8);
    streams.track("c", { requestId: "c" }, RULE, 8);

    expect(streams.take("a")).toBeUndefined();
    expect(streams.take("c")).toEqual({ rule: RULE, receivedBytes: 0 });
  });

  it("counts received bytes and says when streaming is not available", () => {
    const streams = new LargeBodyStreams(undefined, decodeBase64, 10);

    streams.track("a", { requestId: "a", contentLength: 9 }, RULE, 8);
    streams.onData("a", 9, undefined);

    expect(streams.take("a")).toEqual({
      rule: RULE,
      receivedBytes: 9,
      notStreamed: "streaming is not available"
    });
  });
});
