// The DOM replay page. The Player embeds it in
// `<iframe sandbox="allow-scripts allow-same-origin">` under its own CSP
// (`public/replay/index.html`): inline styles are allowed because the rebuilt page needs them,
// scripts come only from this bundle, and resources load only from blob:/data:. rrweb rebuilds
// the recorded page in a nested `sandbox="allow-same-origin"` iframe (no scripts) that inherits
// this CSP, so the recorded page never runs scripts nor reaches the network. The frame must be
// same-origin: under an opaque-origin parent the nested iframe gets its own opaque origin (the
// sandbox flags are inherited) and rrweb cannot reach its document.
import "@rrweb/replay/dist/style.css";
import "./frame.css";

import { Replayer } from "@rrweb/replay";

import {
  DOM_REPLAY_MAX_REPORTED_URLS,
  parsePlayerToFrameMessage,
  replayTargetOrigin,
  type DomReplayResource,
  type FrameToPlayerMessage,
  type PlayerToFrameMessage
} from "../src/lib/dom-replay-protocol.js";
import { rewriteReplayResources } from "../src/lib/dom-replay-resources.js";

type LoadMessage = Extract<PlayerToFrameMessage, { type: "wb-replay/load" }>;
type SeekMessage = Extract<PlayerToFrameMessage, { type: "wb-replay/seek" }>;

const root = document.getElementById("replay-root");
let replayer: Replayer | null = null;
let highlightBox: HTMLDivElement | null = null;
let objectUrls: string[] = [];
let recordedSize = { width: 0, height: 0 };

function send(message: FrameToPlayerMessage): void {
  window.parent.postMessage(message, replayTargetOrigin(window.location.origin));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fitToFrame(): void {
  const wrapper = replayer?.wrapper;

  if (!root || !wrapper || recordedSize.width <= 0 || recordedSize.height <= 0) {
    return;
  }

  const scale = Math.min(
    root.clientWidth / recordedSize.width,
    root.clientHeight / recordedSize.height,
    1
  );
  wrapper.style.transform = `scale(${scale})`;
}

function resetReplay(): void {
  replayer?.destroy();
  replayer = null;
  highlightBox = null;

  for (const url of objectUrls) {
    URL.revokeObjectURL(url);
  }

  objectUrls = [];
}

function createResolver(resources: readonly DomReplayResource[]): (url: string) => string | null {
  const local = new Map<string, string>();

  for (const resource of resources) {
    const objectUrl = URL.createObjectURL(resource.blob);
    objectUrls = [...objectUrls, objectUrl];
    local.set(resource.url, objectUrl);
  }

  return (url) => local.get(url) ?? null;
}

function load(message: LoadMessage): void {
  if (!root) {
    throw new Error("The replay page has no root element.");
  }

  resetReplay();
  const resolve = createResolver(message.resources);
  const { events, unresolved } = rewriteReplayResources(message.events, resolve);
  // rrweb's own event type is wider than our recorded shape; the frame validated the basics.
  const next = new Replayer(events as ConstructorParameters<typeof Replayer>[0], {
    root,
    mouseTail: false,
    showWarning: false,
    triggerFocus: false,
    pauseAnimation: true,
    UNSAFE_replayCanvas: false,
    useVirtualDom: true
  });

  next.on("resize", (dimension) => {
    const { width, height } = dimension as { width: number; height: number };
    recordedSize = { width, height };
    fitToFrame();
  });
  replayer = next;
  highlightBox = document.createElement("div");
  highlightBox.className = "wb-highlight";
  highlightBox.hidden = true;
  next.wrapper.appendChild(highlightBox);
  next.pause(0);
  fitToFrame();
  send({
    type: "wb-replay/loaded",
    eventCount: events.length,
    resolvedResources: message.resources.length,
    unresolvedUrls: [...unresolved].slice(0, DOM_REPLAY_MAX_REPORTED_URLS)
  });
}

function showHighlight(nodeId: number): void {
  const node = replayer?.getMirror().getNode(nodeId) ?? null;
  // The node lives in the rebuilt page's realm: `instanceof Element` of this window is false.
  const element =
    node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : (node?.parentElement ?? null);

  if (!highlightBox || !element) {
    if (highlightBox) {
      highlightBox.hidden = true;
    }

    send({ type: "wb-replay/highlight", nodeId, found: false, tagName: null, rect: null });
    return;
  }

  const rect = element.getBoundingClientRect();
  highlightBox.hidden = false;
  highlightBox.style.left = `${rect.left}px`;
  highlightBox.style.top = `${rect.top}px`;
  highlightBox.style.width = `${rect.width}px`;
  highlightBox.style.height = `${rect.height}px`;
  send({
    type: "wb-replay/highlight",
    nodeId,
    found: true,
    tagName: element.tagName,
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  });
}

function seek(message: SeekMessage): void {
  if (!replayer) {
    return;
  }

  const { startTime, totalTime } = replayer.getMetaData();
  const offset = Math.min(Math.max(message.timestamp - startTime, 0), totalTime);
  const startedAt = performance.now();
  replayer.pause(offset);
  send({
    type: "wb-replay/seeked",
    timestamp: message.timestamp,
    durationMs: performance.now() - startedAt
  });

  if (message.highlightNodeId === null) {
    if (highlightBox) {
      highlightBox.hidden = true;
    }

    return;
  }

  showHighlight(message.highlightNodeId);
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent || event.origin !== window.location.origin) {
    return;
  }

  const message = parsePlayerToFrameMessage(event.data);

  if (!message) {
    return;
  }

  try {
    if (message.type === "wb-replay/load") {
      load(message);
    } else {
      seek(message);
    }
  } catch (error) {
    send({ type: "wb-replay/error", message: toErrorMessage(error) });
  }
});
window.addEventListener("resize", fitToFrame);
send({ type: "wb-replay/ready" });
