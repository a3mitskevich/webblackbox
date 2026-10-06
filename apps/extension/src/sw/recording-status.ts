import { DEFAULT_POINTER_CAPTURE_OPTIONS, DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import type { PointerCaptureOptions } from "@webblackbox/protocol";
import { INJECTED_BRIDGE_NONCE_SETTER_KEY } from "webblackbox/injected-hooks";

import type { ChromeApi } from "../shared/chrome-api.js";
import { normalizeBodyCaptureMaxBytes } from "./body-capture-utils.js";
import type { SessionRuntime } from "./session-registry.js";

export type ScriptingApiLike = NonNullable<ChromeApi["scripting"]>;

export type RecordingSampling = {
  mousemoveHz: number;
  scrollHz: number;
  domFlushMs: number;
  snapshotIntervalMs: number;
  screenshotIdleMs: number;
  bodyCaptureMaxBytes: number;
};

export function toStatusPointer(runtime: SessionRuntime): PointerCaptureOptions {
  return { ...DEFAULT_POINTER_CAPTURE_OPTIONS, ...runtime.config.pointer };
}

export function toStatusSampling(runtime: SessionRuntime): RecordingSampling {
  const sampling = runtime.config.sampling;

  return {
    mousemoveHz: Math.max(1, Math.round(asFiniteNumber(sampling.mousemoveHz) ?? 20)),
    scrollHz: Math.max(1, Math.round(asFiniteNumber(sampling.scrollHz) ?? 15)),
    domFlushMs: normalizeSamplingInterval(sampling.domFlushMs, 100),
    snapshotIntervalMs: normalizeSamplingInterval(sampling.snapshotIntervalMs, 20_000),
    screenshotIdleMs: normalizeOptionalSamplingInterval(
      sampling.screenshotIdleMs,
      DEFAULT_RECORDER_CONFIG.sampling.screenshotIdleMs
    ),
    bodyCaptureMaxBytes:
      runtime.config.capturePolicy?.categories.network === "body-allowlist"
        ? normalizeBodyCaptureMaxBytes(sampling.bodyCaptureMaxBytes, 0)
        : 0
  };
}

/**
 * Installs the page hooks in a frame (the top frame by default). On a frame that already has them
 * the script only resets their config to inactive, so callers send the frame its recording
 * status afterwards.
 */
export async function ensureInjectedHooks(
  scripting: ScriptingApiLike | undefined,
  tabId: number,
  bridgeNonce: string,
  frameId?: number
): Promise<void> {
  const target = frameId === undefined ? { tabId } : { tabId, frameIds: [frameId] };

  await scripting
    ?.executeScript({
      target,
      world: "MAIN",
      files: ["injected.js"]
    })
    .catch((error) => {
      console.warn("[WebBlackbox] failed to inject the page hooks", { tabId, frameId, error });
    });
  // Hand the nonce over as a function argument rather than a DOM event, which page
  // scripts could observe.
  await scripting
    ?.executeScript({
      target,
      world: "MAIN",
      func: applyInjectedBridgeNonce,
      args: [INJECTED_BRIDGE_NONCE_SETTER_KEY, bridgeNonce]
    })
    .catch((error) => {
      console.warn("[WebBlackbox] failed to hand the bridge nonce to the page hooks", {
        tabId,
        frameId,
        error
      });
    });
}

/**
 * Runs on Start and after navigations of a recorded tab, whatever the injection mode: frames that
 * already run the content script ignore the second copy (see content/script-guard.ts), and tabs
 * opened before the extension was installed or registered get it too.
 */
export async function ensureContentScriptInjected(
  scripting: ScriptingApiLike | undefined,
  tabId: number
): Promise<void> {
  await scripting
    ?.executeScript({
      target: { tabId, allFrames: true },
      world: "ISOLATED",
      files: ["content.js"]
    })
    .catch((error) => {
      console.warn("[WebBlackbox] failed to inject the content script", { tabId, error });
    });
}

/** Runs in the page MAIN world; must stay self-contained (serialized by Chrome). */
function applyInjectedBridgeNonce(setterKey: string, nonce: string): void {
  const setter = (window as unknown as Record<string, unknown>)[setterKey];

  if (typeof setter === "function") {
    setter(nonce);
  }
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeSamplingInterval(candidate: unknown, fallback: number): number {
  const value = asFiniteNumber(candidate);

  if (value === null) {
    return fallback;
  }

  return Math.max(250, Math.round(value));
}

function normalizeOptionalSamplingInterval(candidate: unknown, fallback: number): number {
  const value = asFiniteNumber(candidate);

  if (value === null) {
    return fallback;
  }

  if (value <= 0) {
    return 0;
  }

  return Math.max(250, Math.round(value));
}
