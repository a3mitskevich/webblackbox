// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@webblackbox/pipeline", () => ({
  IndexedDbPipelineStorage: class {},
  FlightRecorderPipeline: class {
    readonly start = vi.fn(async () => undefined);
    readonly close = vi.fn(async () => undefined);
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
