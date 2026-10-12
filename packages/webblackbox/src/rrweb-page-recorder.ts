import { RRWEB_EVENT_SCHEMA, type RrwebEventBatchPayload } from "@webblackbox/protocol";

import {
  DOM_RECORDER_COMMAND_EVENT,
  DOM_RECORDER_MESSAGE_KIND,
  DOM_RECORDER_NONCE_SETTER_KEY,
  parseDomRecorderCommand,
  type DomRecorderCommand,
  type DomRecorderSignal
} from "./dom-recorder-bridge.js";
import { INJECTED_MESSAGE_SOURCE } from "./injected-hooks.js";
import { monotonicTime } from "./lite-capture-config.js";
import { createRrwebDomRecorder } from "./rrweb-recorder.js";
import type { DomRecorder, DomRecorderFactory } from "./types.js";

const NONCE_MAX_LENGTH = 128;

/**
 * Installs the rrweb recorder in the page's MAIN world (the extension's `injected-dom.js`). It
 * defines one page global, the non-enumerable nonce setter, which also marks it as installed: a
 * second injection into the same document does nothing. It records only between the content
 * script's `start` and `stop` commands (see `dom-recorder-bridge.ts`).
 */
export function installPageDomRecorder(factory: DomRecorderFactory = createRrwebDomRecorder): void {
  if (
    typeof window === "undefined" ||
    Object.prototype.hasOwnProperty.call(window, DOM_RECORDER_NONCE_SETTER_KEY)
  ) {
    return;
  }

  let nonce: string | null = null;
  let recorder: DomRecorder | null = null;
  let session = -1;

  const post = (signal: DomRecorderSignal): void => {
    window.postMessage(
      {
        source: INJECTED_MESSAGE_SOURCE,
        kind: DOM_RECORDER_MESSAGE_KIND,
        ...signal,
        ...(nonce ? { nonce } : {})
      },
      "*"
    );
  };

  const setNonce = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0 && value.length <= NONCE_MAX_LENGTH) {
      nonce = value;
      // Messages before the nonce were dropped by the content side once it expects one.
      post({ signal: "ready" });
    }
  };

  try {
    Object.defineProperty(window, DOM_RECORDER_NONCE_SETTER_KEY, {
      value: setNonce,
      configurable: false,
      enumerable: false,
      writable: false
    });
  } catch {
    // The page defined the key first: no rrweb here; the agent's own DOM capture takes over.
    return;
  }

  const stop = (): void => {
    const current = recorder;
    recorder = null;
    current?.stop();
  };

  const start = (command: Extract<DomRecorderCommand, { command: "start" }>): void => {
    // A repeated start (the content script resends it on `ready`) keeps the running recorder. A
    // stopped one is started again: a new content script (extension reload) can reuse the number.
    if (session === command.session && recorder !== null) {
      post({ signal: "started", session });
      return;
    }

    stop();
    session = command.session;
    const owner = command.session;
    let disabled = false;
    const emit = (payload: RrwebEventBatchPayload, mono: number): void => {
      disabled ||= payload.recorder?.status === "disabled";
      post({ signal: "batch", session: owner, payload, mono });
    };

    try {
      recorder = factory({
        policy: command.policy,
        mode: command.mode,
        emit,
        onDisabled: () => {
          if (session === owner) {
            recorder = null;
          }
        }
      });
    } catch {
      recorder = null;
    }

    post({ signal: "started", session: owner });

    if (!recorder && !disabled) {
      emit(
        {
          schema: RRWEB_EVENT_SCHEMA,
          events: [],
          recorder: { status: "disabled", reason: "start-failed" }
        },
        monotonicTime()
      );
    }
  };

  window.addEventListener(DOM_RECORDER_COMMAND_EVENT, (event: Event) => {
    const command = parseDomRecorderCommand((event as CustomEvent<unknown>).detail);

    switch (command?.command) {
      case "start":
        start(command);
        return;
      case "flush":
        recorder?.flush();
        post({ signal: "flushed", token: command.token });
        return;
      case "stop":
        if (command.session === session) {
          stop();
        }

        return;
      case "checkpoint":
        if (command.session === session) {
          recorder?.checkpoint?.();
        }
    }
  });

  post({ signal: "ready" });
}
