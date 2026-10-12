import type { ChromeApi } from "../shared/chrome-api.js";
import { OFFSCREEN_FLUSH_REQUEST_KIND } from "../shared/offscreen-messages.js";

/** How long an orphaned document gets to persist its pipelines before it is closed. */
export const ORPHANED_FLUSH_TIMEOUT_MS = 3_000;

export type OffscreenDocumentDeps = {
  offscreen: ChromeApi["offscreen"] | undefined;
  runtime: ChromeApi["runtime"] | undefined;
  offscreenPath: string;
  /** Known sessions; an offscreen document is only orphaned when the worker tracks none. */
  sidCount: () => number;
  /** Bound on the orphaned document's final flush; defaults to {@link ORPHANED_FLUSH_TIMEOUT_MS}. */
  orphanedFlushTimeoutMs?: number;
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
   * Stopped recordings were flushed to the encrypted store when they stopped, and recordings
   * that were still running are kept as interrupted ones: the document is first asked to write
   * their last events (bounded), then closed, and the next request creates a fresh one.
   */
  async function closeOrphanedOffscreenDocument(): Promise<void> {
    if (deps.sidCount() > 0 || !(await hasOffscreenDocument())) {
      return;
    }

    await flushOrphanedDocument();
    console.info("[WebBlackbox] closing offscreen document orphaned by a service worker restart");
    await deps.offscreen?.closeDocument();
  }

  async function flushOrphanedDocument(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(
        () => resolve("timeout"),
        deps.orphanedFlushTimeoutMs ?? ORPHANED_FLUSH_TIMEOUT_MS
      );
    });

    try {
      const outcome = await Promise.race([
        deps.runtime?.sendMessage?.({ kind: OFFSCREEN_FLUSH_REQUEST_KIND }),
        timeout
      ]);

      if (outcome === "timeout") {
        console.warn("[WebBlackbox] orphaned offscreen document did not confirm its final flush");
      }
    } catch (error) {
      console.warn("[WebBlackbox] orphaned offscreen document could not flush", error);
    } finally {
      clearTimeout(timer);
    }
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
