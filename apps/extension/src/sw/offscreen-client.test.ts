import { afterEach, describe, expect, it, vi } from "vitest";

import type { PortLike } from "../shared/chrome-api.js";
import {
  createOffscreenClient,
  createSessionPipelineClient,
  OFFSCREEN_DISCONNECTED_ERROR,
  type OffscreenClientDeps
} from "./offscreen-client.js";
import { createPortTrafficMeter, PORT_TRAFFIC_FLAG } from "./port-traffic.js";

type SentRequest = { requestId: string; op: string; sid: string } & Record<string, unknown>;

function createFakePort(): PortLike & { sent: SentRequest[] } {
  const sent: SentRequest[] = [];
  return {
    name: "webblackbox:offscreen",
    sent,
    postMessage: vi.fn((message: unknown) => {
      sent.push(message as SentRequest);
    }),
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() }
  } as unknown as PortLike & { sent: SentRequest[] };
}

function setup(overrides: Partial<OffscreenClientDeps> = {}) {
  const port = createFakePort();
  const scope: Record<string, unknown> = { [PORT_TRAFFIC_FLAG]: true };
  const traffic = createPortTrafficMeter(scope);
  const deps: OffscreenClientDeps = {
    ensurePort: vi.fn(async () => port),
    recoverSession: vi.fn(async () => undefined),
    traffic,
    shouldLogPerf: () => false,
    ...overrides
  };
  const client = createOffscreenClient(deps);

  const answer = (index: number, response: Record<string, unknown>): void => {
    const request = port.sent[index];

    if (!request) {
      throw new Error(`no request #${index}`);
    }

    client.receive({
      kind: "offscreen.pipeline-response",
      requestId: request.requestId,
      ...response
    });
  };

  const waitForRequests = (count: number) =>
    vi.waitFor(() => {
      expect(port.sent).toHaveLength(count);
    });

  return { port, deps, client, traffic, answer, waitForRequests };
}

describe("offscreen client", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a tagged request and resolves the checked result", async () => {
    const { port, client, answer, waitForRequests } = setup();

    const pending = client.request({ op: "ingestBatch", sid: "S-1", events: [] });
    await waitForRequests(1);
    answer(0, { ok: true, result: 512 });

    await expect(pending).resolves.toBe(512);
    expect(port.sent[0]).toMatchObject({
      kind: "sw.pipeline-request",
      op: "ingestBatch",
      sid: "S-1"
    });
    expect(client.pendingCount()).toBe(0);
  });

  it("rejects with the offscreen error text", async () => {
    const { client, answer, waitForRequests } = setup();

    const pending = client.request({ op: "flush", sid: "S-1" });
    await waitForRequests(1);
    answer(0, { ok: false, error: "disk full" });

    await expect(pending).rejects.toThrow("disk full");
  });

  it("rejects a result that does not match the op", async () => {
    const { client, answer, waitForRequests } = setup();

    const pending = client.request({ op: "putBlob", sid: "S-1", mime: "a/b", base64: "AA==" });
    await waitForRequests(1);
    answer(0, { ok: true, result: { not: "a hash" } });

    await expect(pending).rejects.toThrow("content hash");
  });

  it("recovers a session the offscreen document lost and retries once", async () => {
    const { deps, client, answer, waitForRequests } = setup();

    const pending = client.request({ op: "flush", sid: "S-1" });
    await waitForRequests(1);
    answer(0, { ok: false, error: "Pipeline session not found: S-1" });
    await waitForRequests(2);
    answer(1, { ok: true, result: null });

    await expect(pending).resolves.toBeNull();
    expect(deps.recoverSession).toHaveBeenCalledWith("S-1");
  });

  it("does not retry a start or an ordinary failure", async () => {
    const { deps, client, answer, waitForRequests } = setup();

    const start = client.request({
      op: "start",
      sid: "S-1",
      session: { sid: "S-1", tabId: 1, startedAt: 1, mode: "full", url: "", tags: [] }
    });
    await waitForRequests(1);
    answer(0, { ok: false, error: "Pipeline session not found: S-1" });
    await expect(start).rejects.toThrow("Pipeline session not found");

    const flush = client.request({ op: "flush", sid: "S-1" });
    await waitForRequests(2);
    answer(1, { ok: false, error: "quota exceeded" });
    await expect(flush).rejects.toThrow("quota exceeded");

    expect(deps.recoverSession).not.toHaveBeenCalled();
  });

  it("fails waiting requests when the port disconnects, and retries them after recovery", async () => {
    const { deps, client, answer, waitForRequests } = setup();

    const pending = client.request({ op: "flush", sid: "S-1" });
    await waitForRequests(1);
    client.rejectPending(OFFSCREEN_DISCONNECTED_ERROR);
    await waitForRequests(2);
    answer(1, { ok: true });

    await expect(pending).resolves.toBeNull();
    expect(deps.recoverSession).toHaveBeenCalledTimes(1);
  });

  it("times out a request the offscreen document never answers", async () => {
    vi.useFakeTimers();
    const { client } = setup({ timeoutMs: { default: 1_000, exportDownload: 5_000 } });

    const pending = client.requestOnce({ op: "flush", sid: "S-1" });
    const assertion = expect(pending).rejects.toThrow(
      "Timed out waiting for offscreen response: flush"
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await assertion;
    expect(client.pendingCount()).toBe(0);
  });

  it("gives an export the longer timeout", async () => {
    vi.useFakeTimers();
    const { client, answer } = setup({ timeoutMs: { default: 1_000, exportDownload: 5_000 } });

    const pending = client.requestOnce({ op: "exportDownload", sid: "S-1" });
    await vi.advanceTimersByTimeAsync(4_000);
    answer(0, { ok: true, result: { sizeBytes: 3, downloadUrl: "blob:x" } });

    await expect(pending).resolves.toMatchObject({ sizeBytes: 3, downloadUrl: "blob:x" });
  });

  it("hands events back and ignores late, unknown or malformed responses", () => {
    const { client } = setup();

    expect(client.receive({ kind: "offscreen.ready", t: 1 })).toEqual({
      kind: "offscreen.ready",
      t: 1
    });
    expect(
      client.receive({ kind: "offscreen.pipeline-response", requestId: "nobody", ok: true })
    ).toBeNull();
    expect(client.receive({ kind: "offscreen.screen-recording-chunk", sid: "S" })).toBeNull();
    expect(client.receive("garbage")).toBeNull();
  });

  it("fails the request when posting throws", async () => {
    const port = createFakePort();
    vi.mocked(port.postMessage).mockImplementation(() => {
      throw new Error("Attempting to use a disconnected port object");
    });
    const { client } = setup({ ensurePort: async () => port });

    await expect(client.requestOnce({ op: "flush", sid: "S-1" })).rejects.toThrow(
      "disconnected port"
    );
    expect(client.pendingCount()).toBe(0);
  });
});

describe("session pipeline client", () => {
  it("sends blob bytes as base64 and counts them as binary traffic", async () => {
    const { port, client, traffic, answer, waitForRequests } = setup();
    const pipeline = createSessionPipelineClient(client, "S-1");
    const bytes = Uint8Array.from({ length: 300 }, (_, index) => index & 0xff);

    const stored = pipeline.putBlob("image/webp", bytes);
    await waitForRequests(1);
    answer(0, { ok: true, result: "hash-1" });

    await expect(stored).resolves.toBe("hash-1");
    const sent = port.sent[0];
    expect(sent).toMatchObject({ op: "putBlob", mime: "image/webp" });
    expect(Buffer.from(String(sent?.base64), "base64")).toEqual(Buffer.from(bytes));
    expect(sent).not.toHaveProperty("bytes");

    const counter = traffic.snapshot().byKind.putBlob;
    expect(counter?.binaryBytes).toBe(300);
    // base64 costs about 4/3 of the raw size, not ~10x like a JSON number map.
    expect(counter?.bytes).toBeLessThan(300 * 1.5 + 200);
  });

  it("maps every pipeline call onto its op", async () => {
    const { port, client, answer, waitForRequests } = setup();
    const pipeline = createSessionPipelineClient(client, "S-9");

    const calls = [
      pipeline.ingest({ id: "E" } as never),
      pipeline.flush(),
      pipeline.close({ purge: true })
    ];
    await waitForRequests(3);
    port.sent.forEach((_, index) => answer(index, { ok: true }));
    await Promise.all(calls);

    expect(port.sent.map((request) => [request.op, request.sid])).toEqual([
      ["ingest", "S-9"],
      ["flush", "S-9"],
      ["close", "S-9"]
    ]);
    expect(port.sent[2]).toMatchObject({ purge: true });
  });
});
