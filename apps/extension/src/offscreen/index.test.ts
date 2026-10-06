// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const pipelineMock = vi.hoisted(() => ({
  instances: [] as Array<{ putBlob: Mock<(mime: string, bytes: Uint8Array) => Promise<string>> }>
}));

vi.mock("@webblackbox/pipeline", () => ({
  IndexedDbPipelineStorage: class {},
  FlightRecorderPipeline: class {
    readonly start = vi.fn(async () => undefined);
    readonly close = vi.fn(async () => undefined);
    readonly putBlob = vi.fn(
      async (_mime: string, bytes: Uint8Array) => `hash-${bytes.byteLength}`
    );

    constructor() {
      pipelineMock.instances.push(this);
    }
  }
}));

// At-rest encryption waits for a storage key from the service worker; these tests drive the
// pipeline directly.
vi.mock("./at-rest-storage.js", () => ({
  createAtRestStorageProvider: () => ({
    acceptKey: async () => undefined,
    getStorage: async () => ({})
  })
}));

type PortMessageHandler = (message: unknown) => void;

type PipelineResponse = {
  kind: "offscreen.pipeline-response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

class FakePort {
  readonly name = "webblackbox:offscreen";
  readonly postMessage = vi.fn((message: unknown) => {
    void message;
  });
  private readonly messageHandlers = new Set<PortMessageHandler>();

  readonly onMessage = {
    addListener: (handler: PortMessageHandler): void => {
      this.messageHandlers.add(handler);
    },
    removeListener: (handler: PortMessageHandler): void => {
      this.messageHandlers.delete(handler);
    }
  };

  readonly onDisconnect = {
    addListener: (): void => {
      void 0;
    },
    removeListener: (): void => {
      void 0;
    }
  };

  emit(message: unknown): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }
}

class FakeVideoTrack extends EventTarget {
  readonly stop = vi.fn();

  getSettings(): MediaTrackSettings {
    return { width: 1280, height: 720, frameRate: 30 };
  }
}

class FakeMediaRecorder extends EventTarget {
  static readonly instances: FakeMediaRecorder[] = [];
  static isTypeSupported(): boolean {
    return true;
  }

  state: "inactive" | "recording" = "inactive";
  readonly mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly requestData = vi.fn();
  readonly stop = vi.fn(() => {
    this.state = "inactive";
    this.dispatchEvent(new Event("stop"));
  });

  constructor(_stream: unknown, options: { mimeType: string }) {
    super();
    this.mimeType = options.mimeType;
    FakeMediaRecorder.instances.push(this);
  }

  start(): void {
    this.state = "recording";
  }
}

const SID = "S-test";
let port: FakePort;
let videoTrack: FakeVideoTrack;
let requestCounter = 0;

function installChromeStub(): void {
  Reflect.set(globalThis, "chrome", {
    runtime: {
      connect: vi.fn(() => port),
      onMessage: {
        addListener: vi.fn()
      }
    }
  });
}

function installMediaStubs(): void {
  videoTrack = new FakeVideoTrack();
  const stream = {
    getVideoTracks: () => [videoTrack],
    getAudioTracks: () => [],
    getTracks: () => [videoTrack]
  };

  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => stream) }
  });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
}

async function request(
  op: string,
  fields: Record<string, unknown> = {}
): Promise<PipelineResponse> {
  requestCounter += 1;
  const requestId = `R-${requestCounter}`;
  port.emit({ kind: "sw.pipeline-request", requestId, op, sid: SID, ...fields });

  return vi.waitFor(() => {
    const response = port.postMessage.mock.calls
      .map(([message]) => message as PipelineResponse)
      .find(
        (message) =>
          message?.kind === "offscreen.pipeline-response" && message.requestId === requestId
      );

    if (!response) {
      throw new Error(`no response for ${requestId}`);
    }

    return response;
  });
}

async function startSession(): Promise<void> {
  const response = await request("start", {
    session: { sid: SID, tabId: 1, startedAt: Date.now(), mode: "full" }
  });
  expect(response.ok).toBe(true);
}

describe("offscreen pipeline close", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    port = new FakePort();
    FakeMediaRecorder.instances.length = 0;
    pipelineMock.instances.length = 0;
    installChromeStub();
    installMediaStubs();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.resetModules();
    await import("./index.js");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(globalThis, "chrome");
    Reflect.deleteProperty(navigator, "mediaDevices");
  });

  it("closes a session whose tab video already stopped without a warning", async () => {
    await startSession();

    const closed = await request("close", { purge: true });

    expect(closed.ok).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("stops a live tab video when its session closes", async () => {
    await startSession();
    const started = await request("startScreenRecording", {
      recordingId: "REC-1",
      streamId: "stream-1",
      source: "tab"
    });
    expect(started.ok).toBe(true);
    const recorder = FakeMediaRecorder.instances[0];
    expect(recorder?.state).toBe("recording");

    const closed = await request("close");

    expect(closed.ok).toBe(true);
    expect(recorder?.stop).toHaveBeenCalledTimes(1);
    expect(videoTrack.stop).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("answers an explicit stop for an already finished recording with an empty result", async () => {
    await startSession();

    const stopped = await request("stopScreenRecording", {
      recordingId: "REC-gone",
      reason: "session-stop"
    });

    expect(stopped.ok).toBe(true);
    expect(stopped.result).toMatchObject({ recordingId: "REC-gone", chunkCount: 0, size: 0 });
    expect(warn).not.toHaveBeenCalled();
  });
});

/** jsdom's Blob has no `arrayBuffer()`; MediaRecorder hands the document a real one. */
function videoBlob(bytes: number[]): Blob {
  const data = new Uint8Array(bytes);
  return {
    size: data.byteLength,
    type: "video/webm",
    arrayBuffer: async () => data.buffer
  } as unknown as Blob;
}

function postedMessages(kind: string): Array<Record<string, unknown>> {
  return port.postMessage.mock.calls
    .map(([message]) => message as Record<string, unknown>)
    .filter((message) => message?.kind === kind);
}

async function startTabVideo(): Promise<FakeMediaRecorder> {
  await startSession();
  const started = await request("startScreenRecording", {
    recordingId: "REC-1",
    streamId: "stream-1",
    source: "tab"
  });
  expect(started.ok).toBe(true);
  const recorder = FakeMediaRecorder.instances[0];

  if (!recorder) {
    throw new Error("no media recorder");
  }

  return recorder;
}

describe("offscreen tab video chunks", () => {
  beforeEach(async () => {
    port = new FakePort();
    FakeMediaRecorder.instances.length = 0;
    pipelineMock.instances.length = 0;
    installChromeStub();
    installMediaStubs();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.resetModules();
    await import("./index.js");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(globalThis, "chrome");
    Reflect.deleteProperty(navigator, "mediaDevices");
  });

  it("stores each chunk in the session pipeline and posts only its metadata", async () => {
    const recorder = await startTabVideo();
    const pipeline = pipelineMock.instances[0];

    recorder.ondataavailable?.({
      data: videoBlob([1, 2, 3, 4])
    });

    const chunk = await vi.waitFor(() => {
      const [message] = postedMessages("offscreen.screen-recording-chunk");

      if (!message) {
        throw new Error("no chunk message");
      }

      return message;
    });

    expect(pipeline?.putBlob).toHaveBeenCalledTimes(1);
    const [mime, bytes] = pipeline?.putBlob.mock.calls[0] ?? [];
    expect(mime).toBe("video/webm");
    expect(Array.from(bytes ?? [])).toEqual([1, 2, 3, 4]);
    expect(chunk).toMatchObject({
      sid: SID,
      recordingId: "REC-1",
      index: 0,
      mime: "video/webm",
      chunkId: "hash-4",
      size: 4
    });
    expect(chunk).not.toHaveProperty("bytes");

    const stopped = await request("stopScreenRecording", { recordingId: "REC-1", reason: "test" });
    expect(stopped.result).toMatchObject({ recordingId: "REC-1", chunkCount: 1, size: 4 });
  });

  it("reports a chunk the pipeline could not store and leaves it out of the totals", async () => {
    const recorder = await startTabVideo();
    pipelineMock.instances[0]?.putBlob.mockRejectedValueOnce(new Error("disk full"));

    recorder.ondataavailable?.({
      data: videoBlob([9, 9])
    });

    const error = await vi.waitFor(() => {
      const [message] = postedMessages("offscreen.screen-recording-error");

      if (!message) {
        throw new Error("no error message");
      }

      return message;
    });

    expect(error).toMatchObject({
      sid: SID,
      recordingId: "REC-1",
      stage: "chunk",
      message: "disk full"
    });
    expect(postedMessages("offscreen.screen-recording-chunk")).toHaveLength(0);

    const stopped = await request("stopScreenRecording", { recordingId: "REC-1", reason: "test" });
    expect(stopped.result).toMatchObject({ chunkCount: 0, size: 0 });
  });

  it("answers the stop only after the last chunk's metadata was posted", async () => {
    const recorder = await startTabVideo();
    let releaseWrite: (hash: string) => void = () => undefined;
    pipelineMock.instances[0]?.putBlob.mockImplementationOnce(
      () => new Promise<string>((resolve) => (releaseWrite = resolve))
    );

    recorder.ondataavailable?.({ data: videoBlob([7]) });
    const stopping = request("stopScreenRecording", { recordingId: "REC-1", reason: "test" });
    await vi.waitFor(() => expect(pipelineMock.instances[0]?.putBlob).toHaveBeenCalled());
    releaseWrite("hash-late");
    await stopping;

    const kinds = port.postMessage.mock.calls.map(
      ([message]) => (message as { kind?: string }).kind
    );
    const chunkAt = kinds.indexOf("offscreen.screen-recording-chunk");
    const responseAt = kinds.lastIndexOf("offscreen.pipeline-response");
    expect(chunkAt).toBeGreaterThanOrEqual(0);
    expect(chunkAt).toBeLessThan(responseAt);
  });
});
