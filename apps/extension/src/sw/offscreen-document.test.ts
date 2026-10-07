import { describe, expect, it, vi } from "vitest";

import type { ChromeApi } from "../shared/chrome-api.js";
import { createOffscreenDocumentController } from "./offscreen-document.js";

type Harness = {
  controller: ReturnType<typeof createOffscreenDocumentController>;
  createDocument: ReturnType<typeof vi.fn>;
  closeDocument: ReturnType<typeof vi.fn>;
  getContexts: ReturnType<typeof vi.fn>;
  setSidCount: (count: number) => void;
  setDocumentExists: (exists: boolean) => void;
};

function createHarness(options: { sidCount?: number; documentExists?: boolean } = {}): Harness {
  let sidCount = options.sidCount ?? 0;
  let documentExists = options.documentExists ?? false;
  const createDocument = vi.fn(async () => {
    documentExists = true;
  });
  const closeDocument = vi.fn(async () => {
    documentExists = false;
  });
  const getContexts = vi.fn(async () => (documentExists ? [{ documentUrl: "offscreen" }] : []));

  const controller = createOffscreenDocumentController({
    offscreen: { createDocument, closeDocument } as unknown as ChromeApi["offscreen"],
    runtime: {
      getContexts,
      getURL: (path: string) => `chrome-extension://test/${path}`
    } as unknown as ChromeApi["runtime"],
    offscreenPath: "offscreen.html",
    sidCount: () => sidCount
  });

  return {
    controller,
    createDocument,
    closeDocument,
    getContexts,
    setSidCount: (count) => {
      sidCount = count;
    },
    setDocumentExists: (exists) => {
      documentExists = exists;
    }
  };
}

describe("createOffscreenDocumentController", () => {
  it("closes an offscreen document orphaned by a worker restart at boot", async () => {
    const { controller, closeDocument } = createHarness({ documentExists: true, sidCount: 0 });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await controller.orphanedCleanup;

    expect(closeDocument).toHaveBeenCalledTimes(1);
    info.mockRestore();
  });

  it("keeps the offscreen document when the worker still tracks sessions", async () => {
    const { controller, closeDocument } = createHarness({ documentExists: true, sidCount: 2 });

    await controller.orphanedCleanup;

    expect(closeDocument).not.toHaveBeenCalled();
  });

  it("creates the document once for concurrent callers", async () => {
    const { controller, createDocument } = createHarness();
    let releaseCreate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });

    createDocument.mockImplementationOnce(async () => {
      await gate;
    });

    const first = controller.ensureOffscreenDocument();
    const second = controller.ensureOffscreenDocument();

    releaseCreate();
    await Promise.all([first, second]);

    expect(createDocument).toHaveBeenCalledTimes(1);
  });

  it("does not create a document that already exists", async () => {
    const { controller, createDocument } = createHarness({ documentExists: true, sidCount: 1 });

    await controller.ensureOffscreenDocument();

    expect(createDocument).not.toHaveBeenCalled();
  });

  it("waits for the orphaned cleanup before checking for a document", async () => {
    const { controller, createDocument, closeDocument, setDocumentExists } = createHarness({
      documentExists: true,
      sidCount: 0
    });

    await controller.ensureOffscreenDocument();

    // The orphan was closed first, so a fresh document had to be created.
    expect(closeDocument).toHaveBeenCalledTimes(1);
    expect(createDocument).toHaveBeenCalledTimes(1);

    setDocumentExists(true);
    await controller.ensureOffscreenDocument();
    expect(createDocument).toHaveBeenCalledTimes(1);
  });

  it("logs a failed orphaned cleanup and still creates the document", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const createDocument = vi.fn(async () => undefined);
    const controller = createOffscreenDocumentController({
      offscreen: { createDocument } as unknown as ChromeApi["offscreen"],
      runtime: {
        getContexts: vi
          .fn()
          .mockRejectedValueOnce(new Error("contexts unavailable"))
          .mockResolvedValue([]),
        getURL: (path: string) => `chrome-extension://test/${path}`
      } as unknown as ChromeApi["runtime"],
      offscreenPath: "offscreen.html",
      sidCount: () => 0
    });

    await expect(controller.orphanedCleanup).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "[WebBlackbox] failed to close orphaned offscreen document",
      expect.any(Error)
    );

    await controller.ensureOffscreenDocument();
    expect(createDocument).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("reports no document when the runtime cannot list contexts", async () => {
    const controller = createOffscreenDocumentController({
      offscreen: undefined,
      runtime: undefined,
      offscreenPath: "offscreen.html",
      sidCount: () => 1
    });

    await controller.orphanedCleanup;

    await expect(controller.hasOffscreenDocument()).resolves.toBe(false);
  });
});
