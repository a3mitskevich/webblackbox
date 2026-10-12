import { DEFAULT_POINTER_CAPTURE_OPTIONS, DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import type { CapturePolicy, PointerCaptureOptions } from "@webblackbox/protocol";
import { DOM_RECORDER_NONCE_SETTER_KEY } from "webblackbox/dom-recorder-bridge";
import { INJECTED_BRIDGE_NONCE_SETTER_KEY } from "webblackbox/injected-hooks";

import type { ChromeApi } from "../shared/chrome-api.js";
import { EXTENSION_FILES } from "../shared/extension-files.js";
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

/** The page-world rrweb recorder (`injected-dom.js`) runs where the profile records the DOM. */
export function recordsDom(policy: CapturePolicy | undefined): boolean {
  return policy !== undefined && policy.categories.dom !== "off";
}

/**
 * Installs the page hooks in a frame (the top frame by default). On a frame that already has them
 * the script only resets their config to inactive, so callers send the frame its recording
 * status afterwards. With `domRecorder` the top frame also gets the rrweb DOM recorder, which
 * idles until the content script starts it (a second copy in the same document does nothing).
 */
export async function ensureInjectedHooks(
  scripting: ScriptingApiLike | undefined,
  tabId: number,
  bridgeNonce: string,
  frameId?: number,
  options: { domRecorder?: boolean } = {}
): Promise<void> {
  const target = frameId === undefined ? { tabId } : { tabId, frameIds: [frameId] };

  await scripting
    ?.executeScript({
      target,
      world: "MAIN",
      files: [EXTENSION_FILES.injectedHooks]
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

  if (options.domRecorder && (frameId === undefined || frameId === TOP_FRAME_ID)) {
    await ensurePageDomRecorder(scripting, tabId, bridgeNonce);
  }
}

const TOP_FRAME_ID = 0;

/** rrweb in the top frame's MAIN world, with the session nonce for its bridge messages. */
async function ensurePageDomRecorder(
  scripting: ScriptingApiLike | undefined,
  tabId: number,
  bridgeNonce: string
): Promise<void> {
  const target = { tabId, frameIds: [TOP_FRAME_ID] };

  try {
    await scripting?.executeScript({ target, world: "MAIN", files: [EXTENSION_FILES.domRecorder] });
    await scripting?.executeScript({
      target,
      world: "MAIN",
      func: applyInjectedBridgeNonce,
      args: [DOM_RECORDER_NONCE_SETTER_KEY, bridgeNonce]
    });
  } catch (error) {
    // The agent's own DOM capture takes over when the page recorder never answers.
    console.warn("[WebBlackbox] failed to inject the DOM recorder", { tabId, error });
  }
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
      files: [EXTENSION_FILES.contentScript]
    })
    .catch((error) => {
      console.warn("[WebBlackbox] failed to inject the content script", { tabId, error });
    });
}

/**
 * Injects the capture agent into one frame's isolated world, where the frame's content script
 * picks it up (see `content-agent-api.ts`). Only frames that record ever parse it.
 */
export async function injectContentAgent(
  scripting: ScriptingApiLike | undefined,
  tabId: number,
  frameId: number
): Promise<boolean> {
  if (!scripting) {
    return false;
  }

  try {
    await scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: "ISOLATED",
      files: [EXTENSION_FILES.contentAgent]
    });
    return true;
  } catch (error) {
    console.warn("[WebBlackbox] failed to inject the capture agent", { tabId, frameId, error });
    return false;
  }
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
