import {
  isContentRedactionEnabled,
  recordUrl,
  type CapturePolicy,
  type RedactionRules
} from "@webblackbox/protocol";

import type { PointerTargetDetail } from "./pointer-capture.js";
import { buildReadableTarget, readDataTestId, readTargetRect } from "./pointer-target.js";
import type { LiteCaptureState } from "./types.js";

const TARGET_ENRICH_DELAY_MS = 0;
const SELECTOR_CACHE_MAX = 1_500;

export type TargetPayloadDetail = "action" | "input" | "fast" | "navigation";

/** Per-agent salt of selector token hashes; null records tokens as-is. */
export type SelectorSalt = string | null;

type TargetPayloadsDeps = {
  /** Capture policy of the current session, read on every call. */
  policy: () => CapturePolicy;
  mode: () => LiteCaptureState["mode"];
  /** False once recording stopped or the agent was disposed: pending enrichment then does nothing. */
  isActive: () => boolean;
};

/**
 * Target payloads of recorded events: hashed (and cached) selectors, readable targets and the
 * bounding rects filled in after the event handlers ran.
 */
export class LiteTargetPayloads {
  private selectorCache = new WeakMap<Element, string>();
  private selectorCacheSize = 0;
  private readonly hashingSalt = createSelectorSalt();
  private pendingTargetEnrichmentTimers = new Set<number>();

  public constructor(private readonly deps: TargetPayloadsDeps) {}

  private get capturePolicy(): CapturePolicy {
    return this.deps.policy();
  }

  private get mode(): LiteCaptureState["mode"] {
    return this.deps.mode();
  }

  /** The salt that hashes selector tokens, or null to record them as-is (masking off). */
  public selectorSalt(): SelectorSalt {
    return isContentRedactionEnabled(this.capturePolicy.redaction) ? this.hashingSalt : null;
  }

  public readCachedSelector(target: EventTarget | null): string {
    if (!(target instanceof Element)) {
      return "unknown";
    }

    const cached = this.selectorCache.get(target);

    if (cached) {
      return cached;
    }

    if (this.selectorCacheSize >= SELECTOR_CACHE_MAX) {
      this.selectorCache = new WeakMap<Element, string>();
      this.selectorCacheSize = 0;
    }

    const selector = safeSelector(target, this.selectorSalt());
    this.selectorCache.set(target, selector);
    this.selectorCacheSize += 1;

    return selector;
  }

  /**
   * Target of a pointer action. `rich` adds the bounding rect and, when the profile allows
   * readable actions, labels and a readable CSS selector; otherwise the target stays hashed.
   */
  public createPointerTargetPayload(
    target: EventTarget | null,
    detail: PointerTargetDetail
  ): Record<string, unknown> {
    if (detail === "fast") {
      return toFastTargetPayload(target, this.selectorSalt());
    }

    const navigationTarget = resolveNavigationTarget(target);
    const element = navigationTarget ?? target;
    const payload = navigationTarget
      ? this.resolveTargetPayload(navigationTarget, "navigation")
      : this.resolveTargetPayload(target, "action");
    this.scheduleTargetRectEnrichment(payload, element);
    return payload;
  }

  /**
   * Fills `rect` right after the event handlers ran instead of on the hot path, where reading it
   * could force a synchronous layout. Fresh payload object, like the lite selector enrichment.
   */
  private scheduleTargetRectEnrichment(
    payload: Record<string, unknown>,
    element: EventTarget | null
  ): void {
    if (!(element instanceof Element)) {
      return;
    }

    const timerId = window.setTimeout(() => {
      this.pendingTargetEnrichmentTimers.delete(timerId);

      if (!this.deps.isActive()) {
        return;
      }

      const rect = readTargetRect(element);

      if (rect) {
        payload.rect = rect;
      }
    }, TARGET_ENRICH_DELAY_MS);

    this.pendingTargetEnrichmentTimers.add(timerId);
  }

  public resolveTargetPayload(
    target: EventTarget | null,
    detail: TargetPayloadDetail
  ): Record<string, unknown> {
    if (detail === "fast") {
      return toFastTargetPayload(target, this.selectorSalt());
    }

    const readable =
      target instanceof Element ? buildReadableTarget(target, this.capturePolicy) : undefined;
    const payload =
      this.mode === "full"
        ? toFastTargetPayload(target, this.selectorSalt())
        : detail === "navigation"
          ? this.createNavigationTargetPayload(target)
          : this.createDeferredTargetPayload(target);

    if (readable) {
      payload.readable = readable;
    }

    return payload;
  }

  private createDeferredTargetPayload(target: EventTarget | null): Record<string, unknown> {
    if (!(target instanceof Element)) {
      return {};
    }

    const payload = toDeferredTargetPayload(target, this.selectorSalt());
    const cachedSelector = this.selectorCache.get(target);

    if (cachedSelector) {
      payload.selector = cachedSelector;
      return payload;
    }

    const timerId = window.setTimeout(() => {
      this.pendingTargetEnrichmentTimers.delete(timerId);

      if (!this.deps.isActive()) {
        return;
      }

      payload.selector = this.readCachedSelector(target);
    }, TARGET_ENRICH_DELAY_MS);

    this.pendingTargetEnrichmentTimers.add(timerId);
    return payload;
  }

  private createNavigationTargetPayload(target: EventTarget | null): Record<string, unknown> {
    const navigationTarget = resolveNavigationTarget(target);

    if (!navigationTarget) {
      return toFastTargetPayload(target, this.selectorSalt());
    }

    const href = sanitizeOptionalUrl(
      navigationTarget.getAttribute("href") ?? navigationTarget.href,
      this.capturePolicy.redaction
    );
    const payload = toFastTargetPayload(navigationTarget, this.selectorSalt());
    payload.selector = this.readCachedSelector(navigationTarget);

    if (href) {
      payload.href = href;
    }

    return payload;
  }

  public clearPendingTargetEnrichmentTimers(): void {
    for (const timerId of this.pendingTargetEnrichmentTimers) {
      clearTimeout(timerId);
    }

    this.pendingTargetEnrichmentTimers.clear();
  }

  /** Forgets every cached selector (the agent is disposed). */
  public resetSelectorCache(): void {
    this.selectorCache = new WeakMap<Element, string>();
    this.selectorCacheSize = 0;
  }
}

export function toDeferredTargetPayload(
  target: Element,
  salt: SelectorSalt
): Record<string, unknown> {
  return {
    ...toFastTargetPayload(target, salt),
    dataTestIdToken: tokenForValue(readDataTestId(target), salt)
  };
}

export function toFastTargetPayload(
  target: EventTarget | null,
  salt: SelectorSalt
): Record<string, unknown> {
  if (!(target instanceof Element)) {
    return {};
  }

  const classTokens = readClassTokens(target)
    .slice(0, 3)
    .map((className) => hashToken(className, salt));
  const payload: Record<string, unknown> = {
    tag: target.tagName,
    idToken: tokenForValue(target.id, salt),
    classTokens: classTokens.length > 0 ? classTokens : undefined
  };

  return stripUndefinedRecord(payload);
}

function resolveNavigationTarget(target: EventTarget | null): HTMLAnchorElement | null {
  if (target instanceof HTMLAnchorElement && hasNavigableHref(target)) {
    return target;
  }

  if (!(target instanceof Element)) {
    return null;
  }

  const anchor = target.closest("a[href]");
  return anchor instanceof HTMLAnchorElement && hasNavigableHref(anchor) ? anchor : null;
}

function hasNavigableHref(anchor: HTMLAnchorElement): boolean {
  const href = anchor.getAttribute("href");
  return typeof href === "string" && href.length > 0;
}

function safeSelector(target: EventTarget | null, salt: SelectorSalt): string {
  if (!(target instanceof Element)) {
    return "unknown";
  }

  const segments: string[] = [];
  let current: Element | null = target;

  while (current && segments.length < 5) {
    let segment = current.tagName.toLowerCase();

    if (current.id) {
      segment += `[id:${hashToken(current.id, salt)}]`;
      segments.unshift(segment);
      break;
    }

    const classNames = readClassTokens(current).slice(0, 2);

    if (classNames.length > 0) {
      segment += classNames.map((name) => `[class:${hashToken(name, salt)}]`).join("");
    }

    const parent: Element | null = current.parentElement;

    if (parent) {
      const index = nthOfType(current);

      if (index > 1) {
        segment += `:nth-of-type(${index})`;
      }
    }

    segments.unshift(segment);
    current = parent;
  }

  return segments.join(" > ");
}

function nthOfType(node: Element): number {
  let index = 1;
  let cursor = node.previousElementSibling;

  while (cursor) {
    if (cursor.tagName === node.tagName) {
      index += 1;
    }

    cursor = cursor.previousElementSibling;
  }

  return index;
}

function readClassTokens(target: Element): string[] {
  if (target.classList.length > 0) {
    return Array.from(target.classList).filter((token) => token.length > 0);
  }

  return typeof target.className === "string"
    ? target.className.split(/\s+/).filter((token) => token.length > 0)
    : [];
}

function tokenForValue(value: string | undefined | null, salt: SelectorSalt): string | undefined {
  return value && value.length > 0 ? hashToken(value, salt) : undefined;
}

/** `salt` null: masking is off and tokens are recorded as they are. */
function hashToken(value: string, salt: SelectorSalt): string {
  return salt === null ? value : `t_${hashString(`${salt}:${value}`)}`;
}

export function createSelectorSalt(): string {
  const bytes = new Uint32Array(2);

  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    bytes[0] = Math.floor(Math.random() * 0xffffffff);
    bytes[1] = Date.now() >>> 0;
  }

  return `${bytes[0]?.toString(36) ?? "0"}${bytes[1]?.toString(36) ?? "0"}`;
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(36).padStart(7, "0");
}

export function stripUndefinedRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function sanitizeOptionalUrl(
  value: string | null | undefined,
  rules: RedactionRules
): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  const sanitized = recordUrl(value, rules);
  return sanitized.length > 0 ? sanitized : undefined;
}
