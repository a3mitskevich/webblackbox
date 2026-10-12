import {
  isRrwebEventBatchPayload,
  RRWEB_EVENT_SCHEMA,
  type CapturePolicy
} from "@webblackbox/protocol";

import { monotonicTime } from "./lite-capture-config.js";
import type {
  DomRecorder,
  DomRecorderContext,
  DomRecorderFactory,
  DomRecorderPageMessage
} from "./types.js";

/**
 * The extension records the DOM with rrweb in the page's MAIN world (`injected-dom.js`): from the
 * isolated world of the content script rrweb misses the CSS rules the page writes through the
 * CSSOM (CSS-in-JS). This module is the channel between the two worlds, without rrweb itself:
 *
 * - content → page: commands as a `DOM_RECORDER_COMMAND_EVENT` CustomEvent on `window` (start
 *   with the policy, flush, stop, checkpoint), like the config of `injected.js`;
 * - page → content: `window.postMessage` messages of the injected bridge (#50) with
 *   `kind: "dom-recorder"`, stamped with the session nonce the service worker handed the page
 *   recorder through `DOM_RECORDER_NONCE_SETTER_KEY`, and validated here field by field.
 */

/** CustomEvent through which the content script drives the page-world recorder. */
export const DOM_RECORDER_COMMAND_EVENT = "webblackbox:dom-recorder";
/**
 * Page-world global (non-enumerable, non-writable) through which the service worker hands the
 * page recorder the bridge nonce; its presence also marks the recorder as installed.
 */
export const DOM_RECORDER_NONCE_SETTER_KEY = "__WEBBLACKBOX_SET_DOM_RECORDER_NONCE__";
/** Bridge message kind of everything the page recorder posts. */
export const DOM_RECORDER_MESSAGE_KIND = "dom-recorder";
/** The page recorder never posts batches with more events than this (see `rrweb-recorder.ts`). */
export const DOM_RECORDER_BATCH_MAX_EVENTS = 200;
/**
 * The page recorder must answer a start within this time, or the agent's own DOM capture takes
 * over (the bundle was not injected, or the page blocked it).
 */
export const DOM_RECORDER_START_TIMEOUT_MS = 5_000;
/** Stop waits at most this long for the page recorder's last batch. */
export const DOM_RECORDER_DRAIN_TIMEOUT_MS = 500;

export type DomRecorderCommand =
  | { command: "start"; session: number; policy: CapturePolicy; mode: DomRecorderContext["mode"] }
  | { command: "flush"; token: number }
  | { command: "stop"; session: number }
  | { command: "checkpoint"; session: number };

/** A page-world message as posted (`signal` + fields), before the bridge stamps it. */
export type DomRecorderSignal =
  | { signal: "batch"; session: number; payload: unknown; mono: number }
  | { signal: "ready" }
  | { signal: "started"; session: number }
  | { signal: "flushed"; token: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A bridge message of the page recorder, validated; null for anything else. */
export function parseDomRecorderPageMessage(value: unknown): DomRecorderPageMessage | null {
  if (!isRecord(value)) {
    return null;
  }

  switch (value.signal) {
    case "ready":
      return { kind: "ready" };
    case "started":
      return isCounter(value.session) ? { kind: "started", session: value.session } : null;
    case "flushed":
      return isCounter(value.token) ? { kind: "flushed", token: value.token } : null;
    case "batch":
      return isCounter(value.session) &&
        typeof value.mono === "number" &&
        Number.isFinite(value.mono) &&
        isRrwebEventBatchPayload(value.payload) &&
        value.payload.events.length <= DOM_RECORDER_BATCH_MAX_EVENTS
        ? { kind: "batch", session: value.session, payload: value.payload, mono: value.mono }
        : null;
    default:
      return null;
  }
}

/** A command from the content script, validated (the page can dispatch the event too). */
export function parseDomRecorderCommand(value: unknown): DomRecorderCommand | null {
  if (!isRecord(value)) {
    return null;
  }

  switch (value.command) {
    case "start":
      return isCounter(value.session) &&
        isRecord(value.policy) &&
        isRecord(value.policy.categories) &&
        isRecord(value.policy.redaction) &&
        (value.mode === "lite" || value.mode === "full")
        ? {
            command: "start",
            session: value.session,
            policy: value.policy as CapturePolicy,
            mode: value.mode
          }
        : null;
    case "flush":
      return isCounter(value.token) ? { command: "flush", token: value.token } : null;
    case "stop":
    case "checkpoint":
      return isCounter(value.session) ? { command: value.command, session: value.session } : null;
    default:
      return null;
  }
}

export type PageWorldDomRecorderRuntime = {
  dispatch: (command: DomRecorderCommand) => void;
  setTimeout: (callback: () => void, ms: number) => number;
  clearTimeout: (timer: number) => void;
};

const DEFAULT_RUNTIME: PageWorldDomRecorderRuntime = {
  dispatch: (command) => {
    window.dispatchEvent(new CustomEvent(DOM_RECORDER_COMMAND_EVENT, { detail: command }));
  },
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (timer) => window.clearTimeout(timer)
};

let nextSession = 1;
let nextFlushToken = 1;

/**
 * The content-script side of the page-world recorder, as a `DomRecorderFactory` for the capture
 * agent. Starting dispatches a `start` command (again when the page recorder reports `ready`:
 * it may install after the agent starts). Batches arrive through the agent's bridge (`receive`).
 * Without an answer in {@link DOM_RECORDER_START_TIMEOUT_MS} the recorder disables itself and the
 * agent's own DOM capture takes over.
 */
export function createPageWorldDomRecorderFactory(
  runtime: PageWorldDomRecorderRuntime = DEFAULT_RUNTIME
): DomRecorderFactory {
  return (context) => createPageWorldDomRecorder(context, runtime);
}

function createPageWorldDomRecorder(
  context: DomRecorderContext,
  runtime: PageWorldDomRecorderRuntime
): DomRecorder {
  const session = nextSession++;
  const pendingDrains = new Map<number, () => void>();
  let state: "starting" | "recording" | "done" = "starting";

  const sendStart = (): void => {
    runtime.dispatch({ command: "start", session, policy: context.policy, mode: context.mode });
  };

  const settleDrains = (): void => {
    const resolvers = [...pendingDrains.values()];
    pendingDrains.clear();
    resolvers.forEach((resolve) => resolve());
  };

  const disable = (): void => {
    if (state === "done") {
      return;
    }

    state = "done";
    runtime.clearTimeout(startTimer);
    // A page recorder that answers late must not record into batches nobody takes.
    runtime.dispatch({ command: "stop", session });
    settleDrains();
    context.onDisabled();
  };

  const startTimer = runtime.setTimeout(() => {
    if (state !== "starting") {
      return;
    }

    context.emit(
      {
        schema: RRWEB_EVENT_SCHEMA,
        events: [],
        recorder: { status: "disabled", reason: "start-failed" }
      },
      monotonicTime()
    );
    disable();
  }, DOM_RECORDER_START_TIMEOUT_MS);

  sendStart();

  return {
    flush: () => {
      if (state !== "done") {
        runtime.dispatch({ command: "flush", token: nextFlushToken++ });
      }
    },
    stop: () => {
      if (state === "done") {
        return;
      }

      state = "done";
      runtime.clearTimeout(startTimer);
      runtime.dispatch({ command: "stop", session });
      settleDrains();
    },
    drain: () => {
      if (state === "done") {
        return Promise.resolve();
      }

      const token = nextFlushToken++;
      return new Promise<void>((resolve) => {
        const timer = runtime.setTimeout(() => {
          pendingDrains.delete(token);
          resolve();
        }, DOM_RECORDER_DRAIN_TIMEOUT_MS);
        pendingDrains.set(token, () => {
          runtime.clearTimeout(timer);
          resolve();
        });
        runtime.dispatch({ command: "flush", token });
      });
    },
    checkpoint: () => {
      if (state === "recording") {
        runtime.dispatch({ command: "checkpoint", session });
      }
    },
    receive: (message) => {
      if (state === "done") {
        return;
      }

      switch (message.kind) {
        case "ready":
          // The page recorder (re)installed: a start sent before it listened was lost.
          sendStart();
          return;
        case "started":
          if (message.session === session && state === "starting") {
            state = "recording";
            runtime.clearTimeout(startTimer);
          }

          return;
        case "flushed":
          pendingDrains.get(message.token)?.();
          pendingDrains.delete(message.token);
          return;
        case "batch":
          if (message.session !== session) {
            return;
          }

          context.emit(message.payload, message.mono);

          if (message.payload.recorder?.status === "disabled") {
            disable();
          }
      }
    }
  };
}
