import type { RawRecorderEvent } from "@webblackbox/recorder";

import {
  INJECTED_MESSAGE_SOURCE,
  INJECTED_RAW_EVENT_TYPES,
  type InjectedCaptureWindowMessage
} from "./injected-hooks.js";
import { monotonicTime } from "./lite-capture-config.js";

const INJECTED_RAW_EVENT_TYPE_SET: ReadonlySet<string> = new Set(INJECTED_RAW_EVENT_TYPES);

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

    if (data.kind === "capture-events" && Array.isArray(data.events)) {
      for (const item of data.events) {
        if (item && typeof item.rawType === "string") {
          queueInjectedRawEvent(host, item);
        }
      }

      return;
    }

    if (data.kind === "marker") {
      host.emitMarker(typeof data.message === "string" ? data.message : "Marker");
    }
  });
}

function queueInjectedRawEvent(
  host: InjectedBridgeHost,
  event: {
    rawType: string;
    payload?: Record<string, unknown>;
    t?: number;
    mono?: number;
  }
): void {
  // Only raw types the hooks emit. Script records ("script") make the extension fetch source
  // maps, so they come from the scanner only, never from page-world messages.
  if (!INJECTED_RAW_EVENT_TYPE_SET.has(event.rawType)) {
    return;
  }

  host.queueRawEvent({
    source: "content",
    rawType: event.rawType,
    tabId: host.tabId(),
    sid: host.sid(),
    t: typeof event.t === "number" ? event.t : Date.now(),
    mono: typeof event.mono === "number" ? event.mono : monotonicTime(),
    payload: event.payload ?? {}
  });
}
