import type { SessionMetadata } from "@webblackbox/protocol";

import type { PipelineStorage } from "./storage.js";

export type PipelineSessionSweepResult = {
  deleted: string[];
  failed: Array<{ sid: string; error: string }>;
};

/**
 * Deletes every stored session (chunks, indexes, integrity, tracked blobs) for which
 * `shouldDelete` returns true. A failing delete is reported and does not stop the sweep.
 */
export async function sweepPipelineSessions(
  storage: PipelineStorage,
  shouldDelete: (session: SessionMetadata) => boolean
): Promise<PipelineSessionSweepResult> {
  if (!storage.listSessions) {
    throw new Error("Pipeline storage does not support listing sessions.");
  }

  const sessions = await storage.listSessions();
  const deleted: string[] = [];
  const failed: PipelineSessionSweepResult["failed"] = [];

  for (const session of sessions) {
    if (!shouldDelete(session)) {
      continue;
    }

    try {
      await storage.deleteSession(session.sid);
      deleted.push(session.sid);
    } catch (error) {
      failed.push({
        sid: session.sid,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { deleted, failed };
}
