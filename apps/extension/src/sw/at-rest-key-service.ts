import type { StorageKeyMessage } from "../shared/at-rest.js";
import type { PortLike } from "../shared/chrome-api.js";
import {
  bootstrapAtRestKey,
  toStorageKeyMessage,
  type AtRestKeyRecord,
  type SessionStorageAreaLike
} from "./at-rest-key.js";

export type AtRestKeyServiceDeps = {
  storageArea: SessionStorageAreaLike | undefined;
  indexedDb: IDBFactory | undefined;
  dbName: string;
  /** Sends a message to the offscreen document over its checked port. */
  post: (port: PortLike, message: StorageKeyMessage) => void;
};

export type AtRestKeyService = {
  getAtRestKey: () => Promise<AtRestKeyRecord>;
  /** This worker minted the key: a new browser session, nothing stored before is readable. */
  isAtRestKeyFresh: () => boolean;
  sendAtRestKeyToOffscreen: (port: PortLike) => Promise<void>;
};

/**
 * This browser session's at-rest key. Each worker instance deletes the pipeline database before
 * any offscreen document opens it (see `bootstrapAtRestKey`). A failure is retried on the next
 * call.
 */
export function createAtRestKeyService(deps: AtRestKeyServiceDeps): AtRestKeyService {
  let atRestKeyReady: Promise<AtRestKeyRecord> | null = null;
  let atRestKeyMinted = false;

  async function initializeAtRestKey(): Promise<AtRestKeyRecord> {
    const state = await bootstrapAtRestKey(deps.storageArea, deps.indexedDb, deps.dbName, {
      onAccessLevelError: (error) => {
        console.warn("[WebBlackbox] failed to restrict storage.session access", error);
      }
    });

    atRestKeyMinted = state.fresh;

    if (state.database === "unavailable") {
      console.warn("[WebBlackbox] IndexedDB is unavailable: leftover recordings were not cleared");
    } else if (state.fresh) {
      // "blocked": the deletion is queued and completes before the database is opened again.
      console.info("[WebBlackbox] new browser session: cleared unexported recordings", {
        outcome: state.database
      });
    }

    return state.record;
  }

  function getAtRestKey(): Promise<AtRestKeyRecord> {
    if (!atRestKeyReady) {
      atRestKeyReady = initializeAtRestKey().catch((error: unknown) => {
        atRestKeyReady = null;
        throw error;
      });
    }

    return atRestKeyReady;
  }

  /** Hands the key to the offscreen document; the port was checked on connect. */
  async function sendAtRestKeyToOffscreen(port: PortLike): Promise<void> {
    try {
      deps.post(port, toStorageKeyMessage(await getAtRestKey()));
    } catch (error) {
      console.warn("[WebBlackbox] failed to send the at-rest key to the offscreen document", error);
    }
  }

  return {
    getAtRestKey,
    isAtRestKeyFresh: () => atRestKeyMinted,
    sendAtRestKeyToOffscreen
  };
}
