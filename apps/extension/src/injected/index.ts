import { installInjectedLiteCaptureHooks } from "webblackbox/injected-hooks";

/** Installs the page hooks, inactive until the content script sends the recording config. */
export function startInjectedHooks(): void {
  installInjectedLiteCaptureHooks({
    active: false,
    bodyCaptureMaxBytes: 0,
    captureNetwork: false,
    exposeBridgeNonceSetter: true
  });
}
