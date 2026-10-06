import { PORT_NAMES } from "../shared/messages.js";

/** Minimal `chrome.runtime.MessageSender` shape the service worker relies on. */
export type RuntimeSenderLike = {
  id?: string;
  url?: string;
  frameId?: number;
  tab?: {
    id?: number;
  };
};

export type SenderTrustContext = {
  extensionId: string;
  /** `chrome-extension://<id>` without a trailing slash. */
  extensionOrigin: string;
  /** Absolute URL of the extension's offscreen document. */
  offscreenUrl: string;
};

export type InboundSenderContext = "extension-page" | "content" | "offscreen" | "untrusted";

const UI_PORT_NAMES: ReadonlySet<string> = new Set([
  PORT_NAMES.popup,
  PORT_NAMES.options,
  PORT_NAMES.sessions
]);

/**
 * Classifies the sender of a `runtime.onConnect` port. The port name is chosen by the
 * connecting script, so it is only trusted when the sender matches it:
 * - offscreen: the extension's own offscreen document (no tab),
 * - content: a frame of a tab that is not an extension page,
 * - popup/options/sessions: an extension page.
 */
export function classifyPortSender(
  portName: string,
  sender: RuntimeSenderLike | undefined,
  context: SenderTrustContext
): InboundSenderContext {
  if (!sender || !isOwnExtensionSender(sender, context)) {
    return "untrusted";
  }

  if (portName === PORT_NAMES.offscreen) {
    return !sender.tab && stripUrlFragment(sender.url) === context.offscreenUrl
      ? "offscreen"
      : "untrusted";
  }

  if (portName === PORT_NAMES.content) {
    return isContentSender(sender, context) ? "content" : "untrusted";
  }

  if (UI_PORT_NAMES.has(portName)) {
    return isExtensionPageUrl(sender.url, context) ? "extension-page" : "untrusted";
  }

  return "untrusted";
}

/** Classifies the sender of a one-shot `runtime.onMessage` message. */
export function classifyMessageSender(
  sender: RuntimeSenderLike | undefined,
  context: SenderTrustContext
): InboundSenderContext {
  if (!sender || !isOwnExtensionSender(sender, context)) {
    return "untrusted";
  }

  if (isExtensionPageUrl(sender.url, context)) {
    return "extension-page";
  }

  return isContentSender(sender, context) ? "content" : "untrusted";
}

/**
 * Which inbound message kinds a sender context may dispatch:
 * - extension pages: `ui.*` commands only,
 * - content scripts: capture traffic and, for now, `ui.*` as well — the headless e2e
 *   harness drives sessions from the content-script world, so restricting `ui.*` to
 *   extension pages needs the harness moved to popup control first,
 * - offscreen document and untrusted senders: nothing (the offscreen port only carries
 *   pipeline responses, handled separately).
 */
export function isInboundKindAllowed(kind: string, context: InboundSenderContext): boolean {
  if (context === "extension-page") {
    return kind.startsWith("ui.");
  }

  if (context === "content") {
    return kind.startsWith("content.") || kind.startsWith("ui.");
  }

  return false;
}

/**
 * Broadcasts reach every connected port except recording status for content scripts: each content
 * script follows only its own tab's recording, which the service worker sends to that tab. Another
 * tab's status would make it record under that tab's session, or stop while its tab records.
 */
export function isBroadcastDeliveredToPort(kind: string, portName: string): boolean {
  return !(kind === "sw.recording-status" && portName === PORT_NAMES.content);
}

function isOwnExtensionSender(sender: RuntimeSenderLike, context: SenderTrustContext): boolean {
  // `onConnect`/`onMessage` only fire for this extension's own contexts; an explicit
  // foreign id means the event came through an unexpected channel.
  return sender.id === undefined || sender.id === context.extensionId;
}

function isContentSender(sender: RuntimeSenderLike, context: SenderTrustContext): boolean {
  return (
    typeof sender.tab?.id === "number" &&
    typeof sender.frameId === "number" &&
    !isExtensionPageUrl(sender.url, context)
  );
}

function isExtensionPageUrl(url: string | undefined, context: SenderTrustContext): boolean {
  return typeof url === "string" && url.startsWith(`${context.extensionOrigin}/`);
}

function stripUrlFragment(url: string | undefined): string | null {
  if (typeof url !== "string") {
    return null;
  }

  const hashIndex = url.indexOf("#");
  return hashIndex >= 0 ? url.slice(0, hashIndex) : url;
}
