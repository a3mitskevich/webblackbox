import type { RawRecorderEvent } from "@webblackbox/recorder";

import { DOM_RECORDER_MESSAGE_KIND, parseDomRecorderPageMessage } from "./dom-recorder-bridge.js";
import {
  INJECTED_MESSAGE_SOURCE,
  INJECTED_RAW_EVENT_TYPES,
  type InjectedCaptureWindowMessage
} from "./injected-hooks.js";
import { monotonicTime } from "./lite-capture-config.js";
import type { DomRecorderPageMessage } from "./types.js";

const INJECTED_RAW_EVENT_TYPE_SET: ReadonlySet<string> = new Set(INJECTED_RAW_EVENT_TYPES);
/** The hooks post at most 24 events per message; a longer batch is not theirs. */
export const INJECTED_BRIDGE_BATCH_MAX = 256;
/** Longer marker text from the page is cut. */
export const INJECTED_MARKER_MAX_CHARS = 1_000;
const DEFAULT_MARKER_MESSAGE = "Marker";

/** What the capture agent provides to the bridge from the page-world hooks. */
export type InjectedBridgeHost = {
  listen<TEvent extends Event>(
    target: EventTarget,
    type: string,
    listener: (event: TEvent) => void,
    options?: AddEventListenerOptions
  ): void;
  /** Session nonce the host set for the hooks; null until one is set. */
  nonce(): string | null;
  queueRawEvent(event: RawRecorderEvent): void;
  /** A message of the page-world DOM recorder (rrweb batches and signals), validated. */
  receiveDomRecorderMessage?(message: DomRecorderPageMessage): void;
  emitMarker(message: string): void;
  tabId(): number;
  sid(): string;
};

/** Relays the capture events and markers that the injected page hooks post to the window. */
export function installInjectedBridgeListener(host: InjectedBridgeHost): void {
  host.listen(window, "message", (event: MessageEvent<unknown>) => {
    if (event.source !== window) {
      return;
    }

    const data = event.data as InjectedCaptureWindowMessage | undefined;

    if (!data || data.source !== INJECTED_MESSAGE_SOURCE) {
      return;
    }

    // Page scripts share the window with the injected hooks and can post look-alike
    // messages; once the host set a session nonce, unstamped messages are forgeries.
    if (host.nonce() !== null && data.nonce !== host.nonce()) {
      return;
    }

    if (data.kind === "capture-event" && typeof data.rawType === "string") {
      queueInjectedRawEvent(host, data);
      return;
    }

    if (
      data.kind === "capture-events" &&
      Array.isArray(data.events) &&
      data.events.length <= INJECTED_BRIDGE_BATCH_MAX
    ) {
      for (const item of data.events) {
        if (item && typeof item.rawType === "string") {
          queueInjectedRawEvent(host, item);
        }
      }

      return;
    }

    if ((data as { kind?: unknown }).kind === DOM_RECORDER_MESSAGE_KIND) {
      const message = parseDomRecorderPageMessage(data);

      if (message) {
        host.receiveDomRecorderMessage?.(message);
      }

      return;
    }

    if (data.kind === "marker") {
      host.emitMarker(
        typeof data.message === "string"
          ? data.message.slice(0, INJECTED_MARKER_MAX_CHARS)
          : DEFAULT_MARKER_MESSAGE
      );
    }
  });
}

/**
 * Page scripts can post these messages too, so every field is checked: the payload must be a plain
 * object, and a time that is not a finite number is replaced by the bridge's own.
 */
function queueInjectedRawEvent(
  host: InjectedBridgeHost,
  event: {
    rawType: string;
    payload?: unknown;
    t?: unknown;
    mono?: unknown;
  }
): void {
  // Only raw types the hooks emit. Script records ("script") make the extension fetch source
  // maps, so they come from the scanner only, never from page-world messages.
  if (!INJECTED_RAW_EVENT_TYPE_SET.has(event.rawType) || !isPlainRecord(event.payload)) {
    return;
  }

  host.queueRawEvent({
    source: "content",
    rawType: event.rawType,
    tabId: host.tabId(),
    sid: host.sid(),
    t: isFiniteNumber(event.t) ? event.t : Date.now(),
    mono: isFiniteNumber(event.mono) ? event.mono : monotonicTime(),
    payload: event.payload
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
