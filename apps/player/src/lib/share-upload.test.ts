import { afterEach, describe, expect, it, vi } from "vitest";

import { isAbortError, uploadArchiveWithProgress } from "./share-upload.js";

type Listener = (event?: object) => void;

/** A request that stays open until the test answers or aborts it. */
class PendingXhr {
  static last: PendingXhr | null = null;
  status = 200;
  responseText = '{"shareId":"x1"}';
  sent = false;
  aborted = false;
  private listeners = new Map<string, Listener>();
  private progressListeners: Listener[] = [];
  upload = {
    addEventListener: (_type: string, listener: Listener) => this.progressListeners.push(listener)
  };

  constructor() {
    PendingXhr.last = this;
  }

  open(): void {}
  setRequestHeader(): void {}
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, listener);
  }
  send(): void {
    this.sent = true;
  }
  abort(): void {
    this.aborted = true;
    this.listeners.get("abort")?.();
  }
  progress(loaded: number, total: number): void {
    this.progressListeners.forEach((listener) =>
      listener({ lengthComputable: true, loaded, total })
    );
  }
  load(): void {
    this.listeners.get("load")?.();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  PendingXhr.last = null;
});

describe("uploadArchiveWithProgress", () => {
  it("uploads with progress when no signal is given (the classic player)", async () => {
    vi.stubGlobal("XMLHttpRequest", PendingXhr);
    const onProgress = vi.fn();
    const pending = uploadArchiveWithProgress("/u", {}, new ArrayBuffer(4), onProgress);

    PendingXhr.last?.progress(2, 4);
    PendingXhr.last?.load();

    await expect(pending).resolves.toEqual({ shareId: "x1" });
    expect(onProgress).toHaveBeenCalledWith(2, 4);
  });

  it("aborts the request on the signal and rejects with an AbortError", async () => {
    vi.stubGlobal("XMLHttpRequest", PendingXhr);
    const onProgress = vi.fn();
    const controller = new AbortController();
    const pending = uploadArchiveWithProgress(
      "/u",
      {},
      new ArrayBuffer(4),
      onProgress,
      "en",
      controller.signal
    );
    const xhr = PendingXhr.last;

    controller.abort();
    xhr?.progress(4, 4);

    const error = await pending.catch((reason: unknown) => reason);
    expect(isAbortError(error)).toBe(true);
    expect((error as Error).message).toBe("Upload aborted.");
    expect(xhr?.aborted).toBe(true);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("never sends when the signal is already aborted", async () => {
    vi.stubGlobal("XMLHttpRequest", PendingXhr);
    const controller = new AbortController();
    controller.abort();

    const error = await uploadArchiveWithProgress(
      "/u",
      {},
      new ArrayBuffer(1),
      () => undefined,
      "en",
      controller.signal
    ).catch((reason: unknown) => reason);

    expect(isAbortError(error)).toBe(true);
    expect(PendingXhr.last).toBeNull();
  });

  it("keeps a plain error for an abort that did not come from the signal", async () => {
    vi.stubGlobal("XMLHttpRequest", PendingXhr);
    const pending = uploadArchiveWithProgress("/u", {}, new ArrayBuffer(1), () => undefined);

    PendingXhr.last?.abort();

    const error = await pending.catch((reason: unknown) => reason);
    expect(isAbortError(error)).toBe(false);
    expect(error).toBeInstanceOf(Error);
  });
});
