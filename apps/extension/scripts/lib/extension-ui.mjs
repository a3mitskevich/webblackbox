import { waitFor } from "./e2e-utils.mjs";

const UI_POLL_INTERVAL_MS = 250;
const INDICATOR_TEXT_EXPRESSION = `(() => document.querySelector('[data-webblackbox-indicator="true"]')?.textContent ?? null)()`;

/** Waits until the in-page recording indicator contains `fragment`; returns its text. */
export async function waitForIndicatorText(pageClient, fragment, timeoutMs) {
  return waitFor(
    async () => {
      const text = await pageClient.evaluate(INDICATOR_TEXT_EXPRESSION);
      return typeof text === "string" && text.includes(fragment) ? text : null;
    },
    timeoutMs,
    UI_POLL_INTERVAL_MS,
    `Indicator not found: ${fragment}`
  );
}

export async function waitForIndicatorGone(pageClient, timeoutMs) {
  return waitFor(
    async () => {
      const text = await pageClient.evaluate(INDICATOR_TEXT_EXPRESSION);
      return text ? null : true;
    },
    timeoutMs,
    UI_POLL_INTERVAL_MS,
    "Indicator not cleared"
  );
}

/** Reads the service worker's persisted runtime sessions via an extension page client. */
export async function readRuntimeSessions(popupClient) {
  const expression = `
    (async () => {
      const store = await chrome.storage.local.get('webblackbox.runtime.sessions');
      const rows = store['webblackbox.runtime.sessions'];
      return Array.isArray(rows) ? rows : [];
    })()
  `;

  return popupClient.evaluate(expression);
}

export async function deleteSessionFromPopup(popupClient, sid) {
  const expression = `
    (async () => {
      await chrome.runtime.sendMessage({ kind: 'ui.delete', sid: ${JSON.stringify(sid)} });
      return { ok: true, sid: ${JSON.stringify(sid)} };
    })()
  `;

  return popupClient.evaluate(expression);
}

/** Waits until an extension page has a live `chrome.runtime` able to send messages. */
export async function waitForPopupRuntimeReady(popupClient, timeoutMs) {
  return waitFor(
    async () => {
      const snapshot = await popupClient.evaluate(`
        (() => ({
          runtimeId:
            typeof chrome === 'object' &&
            chrome !== null &&
            typeof chrome.runtime === 'object' &&
            chrome.runtime !== null &&
            typeof chrome.runtime.id === 'string'
              ? chrome.runtime.id
              : null,
          canSendMessage:
            typeof chrome === 'object' &&
            chrome !== null &&
            typeof chrome.runtime === 'object' &&
            chrome.runtime !== null &&
            typeof chrome.runtime.sendMessage === 'function'
        }))()
      `);

      return snapshot?.runtimeId && snapshot?.canSendMessage ? snapshot : null;
    },
    timeoutMs,
    UI_POLL_INTERVAL_MS,
    "Popup runtime is not ready"
  );
}
