import { describe, expect, it } from "vitest";

import { isServiceRealtimeRecord, parseRealtimePayload } from "./realtime-messages.js";

const RS = "\u001e";

describe("parseRealtimePayload", () => {
  it("reads the SignalR handshake and its answer", () => {
    const request = parseRealtimePayload(`{"protocol":"json","version":1}${RS}`);
    const answer = parseRealtimePayload(`{}${RS}`);

    expect(request.format).toBe("signalr");
    expect(request.records).toEqual([
      {
        kind: "handshake",
        text: `{"protocol":"json","version":1}`,
        value: { protocol: "json", version: 1 },
        complete: true
      }
    ]);
    expect(answer.records[0]?.kind).toBe("handshake-ack");
    expect(isServiceRealtimeRecord(request.records[0]!)).toBe(true);
  });

  it("splits several hub messages of one frame and names their targets", () => {
    const text =
      `{"type":1,"target":"GameState","arguments":[64],"invocationId":"7"}${RS}` +
      `{"type":3,"invocationId":"7","result":{"ok":true}}${RS}{"type":6}${RS}`;
    const parsed = parseRealtimePayload(text);

    expect(parsed.records.map((record) => record.kind)).toEqual([
      "invocation",
      "completion",
      "ping"
    ]);
    expect(parsed.records[0]).toMatchObject({
      target: "GameState",
      invocationId: "7",
      signalrType: 1,
      complete: true
    });
    // A completion with a result is content; a ping is plumbing.
    expect(isServiceRealtimeRecord(parsed.records[1]!)).toBe(false);
    expect(isServiceRealtimeRecord(parsed.records[2]!)).toBe(true);
  });

  it("treats a completion without a result as plumbing, one with a result or error as content", () => {
    const bare = parseRealtimePayload(`{"type":3,"invocationId":"0","result":null}${RS}`);
    const empty = parseRealtimePayload(`{"type":3,"invocationId":"0"}${RS}`);
    const failed = parseRealtimePayload(`{"type":3,"invocationId":"0","error":"boom"}${RS}`);

    expect(isServiceRealtimeRecord(bare.records[0]!)).toBe(true);
    expect(isServiceRealtimeRecord(empty.records[0]!)).toBe(true);
    expect(failed.records[0]).toMatchObject({ kind: "completion", error: "boom" });
    expect(isServiceRealtimeRecord(failed.records[0]!)).toBe(false);
  });

  it("keeps what a cut frame still tells: type, target and the prefix", () => {
    const parsed = parseRealtimePayload(
      `{"type":1,"target":"GameState","arguments":[{"table":64,`,
      {
        truncated: true,
        signalr: true
      }
    );

    expect(parsed).toMatchObject({ format: "signalr", truncated: true });
    expect(parsed.records).toEqual([
      {
        kind: "invocation",
        text: `{"type":1,"target":"GameState","arguments":[{"table":64,`,
        target: "GameState",
        signalrType: 1,
        complete: false
      }
    ]);
  });

  it("marks only the record after the last separator as cut", () => {
    const parsed = parseRealtimePayload(`{"type":6}${RS}{"type":1,"target":"Tick","argu`, {
      truncated: true
    });

    expect(parsed.records.map((record) => [record.kind, record.complete])).toEqual([
      ["ping", true],
      ["invocation", false]
    ]);
  });

  it("reads unknown hub types and malformed records without throwing", () => {
    const parsed = parseRealtimePayload(`{"type":42}${RS}not json${RS}{"a":1}${RS}`);

    expect(parsed.records.map((record) => [record.kind, record.complete])).toEqual([
      ["json", true],
      // Unreadable text is not a whole record: it carries no value.
      ["text", false],
      ["json", true]
    ]);
    expect(parsed.records[1]).not.toHaveProperty("value");
  });

  it("reads a cut record's type and target from its top level only", () => {
    const parsed = parseRealtimePayload(
      `{"type":3,"invocationId":"1","result":{"target":"foo","type":1,"invocationId":"9",`,
      { truncated: true, signalr: true }
    );

    expect(parsed.records).toEqual([
      {
        kind: "completion",
        text: `{"type":3,"invocationId":"1","result":{"target":"foo","type":1,"invocationId":"9",`,
        invocationId: "1",
        signalrType: 3,
        complete: false
      }
    ]);
  });

  it("does not stop the top level at braces inside strings", () => {
    const parsed = parseRealtimePayload(`{"invocationId":"a{[b","type":1,"target":"T","argu`, {
      truncated: true,
      signalr: true
    });

    expect(parsed.records[0]).toMatchObject({
      kind: "invocation",
      invocationId: "a{[b",
      target: "T",
      signalrType: 1
    });
  });

  it("keeps a whole JSON array record's value", () => {
    expect(parseRealtimePayload(`[1,2]${RS}`).records[0]).toEqual({
      kind: "json",
      text: "[1,2]",
      value: [1, 2],
      complete: true
    });
  });

  it("reads plain JSON, cut JSON and text", () => {
    expect(parseRealtimePayload(`{"price":1.5}`)).toEqual({
      format: "json",
      truncated: false,
      records: [{ kind: "json", text: `{"price":1.5}`, value: { price: 1.5 }, complete: true }]
    });
    expect(parseRealtimePayload(`[1,2,`, { truncated: true }).records[0]).toEqual({
      kind: "json",
      text: "[1,2,",
      complete: false
    });
    expect(parseRealtimePayload(`{oops`).records[0]?.kind).toBe("text");
    expect(parseRealtimePayload("hello").format).toBe("text");
  });

  it("reports binary frames and empty payloads", () => {
    expect(parseRealtimePayload("AAEC", { opcode: 2 })).toEqual({
      format: "binary",
      truncated: false,
      records: [{ kind: "binary", text: "AAEC", complete: true }]
    });
    expect(parseRealtimePayload(undefined).format).toBe("empty");
    expect(parseRealtimePayload(RS).records).toEqual([{ kind: "empty", text: "", complete: true }]);
  });
});
