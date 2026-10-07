import type { ChromeApi } from "../shared/chrome-api.js";

export type OffscreenDocumentDeps = {
  offscreen: ChromeApi["offscreen"] | undefined;
  runtime: ChromeApi["runtime"] | undefined;
  offscreenPath: string;
  /** Known sessions; an offscreen document is only orphaned when the worker tracks none. */
  sidCount: () => number;
};

export type OffscreenDocumentController = {
  /** Settles once the boot-time orphaned-document check has run. */
  orphanedCleanup: Promise<void>;
  ensureOffscreenDocument: () => Promise<void>;
  hasOffscreenDocument: () => Promise<boolean>;
  createOffscreenDocument: () => Promise<void>;
  closeOrphanedOffscreenDocument: () => Promise<void>;
};

/**
 * The single offscreen document's lifecycle. Chrome allows exactly one per extension; concurrent
 * callers share one check-then-create, and a document that outlived a service worker restart is
 * closed once at boot so the next request starts fresh.
 */
export function createOffscreenDocumentController(
  deps: OffscreenDocumentDeps
): OffscreenDocumentController {
  let offscreenDocumentReady: Promise<void> | null = null;

  async function hasOffscreenDocument(): Promise<boolean> {
    if (!deps.runtime?.getContexts || !deps.runtime.getURL) {
      return false;
    }

    const contexts = await deps.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [deps.runtime.getURL(deps.offscreenPath)]
    });

    return contexts.length > 0;
  }

  async function createOffscreenDocument(): Promise<void> {
    if (!deps.offscreen?.createDocument) {
      return;
    }

    await deps.offscreen.createDocument({
      url: deps.offscreenPath,
      reasons: ["DOM_PARSER", "USER_MEDIA"],
      justification:
        "WebBlackbox uses offscreen document for persistent local recording pipeline and optional tab video capture."
    });
  }

  /**
   * An offscreen document that outlives a service worker restart keeps pipelines and
   * capture streams the new worker does not track, and its port died with the old worker.
   * Stopped recordings were flushed to the encrypted store when they stopped and are
   * re-attached on demand, so close it and let the next request create a fresh one.
   */
  async function closeOrphanedOffscreenDocument(): Promise<void> {
    if (deps.sidCount() > 0 || !(await hasOffscreenDocument())) {
      return;
    }

    console.info("[WebBlackbox] closing offscreen document orphaned by a service worker restart");
    await deps.offscreen?.closeDocument();
  }

  async function createOffscreenDocumentIfMissing(): Promise<void> {
    await orphanedCleanup;

    if (await hasOffscreenDocument()) {
      return;
    }

    await createOffscreenDocument();
  }

  /** Concurrent callers share one check-then-create: Chrome allows a single offscreen document. */
  function ensureOffscreenDocument(): Promise<void> {
    if (!offscreenDocumentReady) {
      offscreenDocumentReady = createOffscreenDocumentIfMissing().finally(() => {
        offscreenDocumentReady = null;
      });
    }

    return offscreenDocumentReady;
  }

  const orphanedCleanup = closeOrphanedOffscreenDocument().catch((error) => {
    console.warn("[WebBlackbox] failed to close orphaned offscreen document", error);
  });

  return {
    orphanedCleanup,
    ensureOffscreenDocument,
    hasOffscreenDocument,
    createOffscreenDocument,
    closeOrphanedOffscreenDocument
  };
}
