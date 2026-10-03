import {
  createActionId,
  extractRequestId,
  type EventReference,
  type WebBlackboxEvent
} from "@webblackbox/protocol";

const ACTION_START_EVENTS = new Set([
  "user.click",
  "user.dblclick",
  "user.contextmenu",
  "user.auxclick",
  "user.drag.end",
  "user.submit",
  "user.marker",
  "nav.commit"
]);

const KEYBOARD_ACTION_KEYS = new Set(["Enter", "NumpadEnter", "Space"]);
/** The click a browser fires right after a pointer drag belongs to the drag's action. */
const DRAG_FOLLOW_UP_CLICK_MS = 150;
const NETWORK_TERMINAL_EVENTS = new Set(["network.finished", "network.failed"]);

type ActionState = {
  id: string;
  startedAtMono: number;
  expiresAtMono: number;
  startType: string;
};

export class ActionSpanTracker {
  private sequence = 0;

  private currentAction: ActionState | null = null;

  private readonly reqToAction = new Map<string, string>();

  public constructor(private readonly actionWindowMs: number) {}

  public assign(event: WebBlackboxEvent): WebBlackboxEvent {
    const isActionStart = this.isActionStartEvent(event) && !this.isDragFollowUpClick(event);

    if (isActionStart) {
      this.sequence += 1;
      this.currentAction = {
        id: createActionId(this.sequence),
        startedAtMono: event.mono,
        expiresAtMono: event.mono + this.actionWindowMs,
        startType: event.type
      };
      return this.withRef(event, { act: this.currentAction.id });
    }

    const activeAction = this.currentAction;
    const shouldAttachCurrentAction = Boolean(
      activeAction && event.mono <= activeAction.expiresAtMono
    );
    let actionId = shouldAttachCurrentAction ? activeAction?.id : undefined;

    if (event.type === "network.request") {
      const reqId = this.readReqId(event);

      if (reqId && actionId) {
        this.reqToAction.set(reqId, actionId);
      }
    }

    const reqId = this.readReqId(event);
    const eventWithReqRef =
      reqId && event.ref?.req !== reqId ? this.withRef(event, { req: reqId }) : event;

    if (!actionId && event.type.startsWith("network.")) {
      actionId = reqId ? this.reqToAction.get(reqId) : undefined;
    }

    if (!actionId && event.type.startsWith("dom.")) {
      actionId = reqId ? this.reqToAction.get(reqId) : undefined;
    }

    if (reqId && NETWORK_TERMINAL_EVENTS.has(event.type)) {
      this.reqToAction.delete(reqId);
    }

    if (actionId) {
      return this.withRef(eventWithReqRef, { act: actionId });
    }

    return eventWithReqRef;
  }

  private isActionStartEvent(event: WebBlackboxEvent): boolean {
    if (event.type === "user.drag.end") {
      // A cancelled drag (Esc, or a touch pan the browser turned into a scroll) did nothing.
      return this.asRecord(event.data)?.cancelled !== true;
    }

    if (ACTION_START_EVENTS.has(event.type)) {
      return true;
    }

    if (event.type !== "user.keydown") {
      return false;
    }

    const payload = this.asRecord(event.data);
    const key = payload?.key;
    return typeof key === "string" && KEYBOARD_ACTION_KEYS.has(key);
  }

  private isDragFollowUpClick(event: WebBlackboxEvent): boolean {
    const action = this.currentAction;
    return (
      event.type === "user.click" &&
      action !== null &&
      action.startType === "user.drag.end" &&
      event.mono - action.startedAtMono <= DRAG_FOLLOW_UP_CLICK_MS
    );
  }

  private withRef(event: WebBlackboxEvent, refPatch: EventReference): WebBlackboxEvent {
    return {
      ...event,
      ref: {
        ...event.ref,
        ...refPatch
      }
    };
  }

  private readReqId(event: WebBlackboxEvent): string | undefined {
    return extractRequestId(event) ?? undefined;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }
}
