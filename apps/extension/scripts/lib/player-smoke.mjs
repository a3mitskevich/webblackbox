// Thin, UI-agnostic Player smoke for the extension e2e: the exported archive opens with its
// passphrase and the Player lists events. It relies only on what both the classic UI and the React
// UI (`?ui=next`) have — a file input, a password field when the archive is encrypted, and event
// rows — and checks no archive data (the player-sdk checks in `archive-checks.mjs` do that).

const EVENT_ROW_SELECTOR = '#timeline-list .event, [data-testid="event-row"]';
const ERROR_SELECTOR = '[data-testid="archive-error"]';
const SMOKE_POLL_MS = 250;
const RELOAD_RETRY_AFTER_MS = 6_000;

/**
 * Loads `archivePath` into the Player open on `playerClient` (a CDP page client) and waits for
 * event rows. Resolves `{ ok, eventRows, ... }`; the caller asserts.
 */
export async function runPlayerSmoke({ playerClient, archivePath, passphrase, timeoutMs }) {
  await setArchiveFile(playerClient, archivePath);

  const startedAt = Date.now();
  let retried = false;
  let last = null;

  while (Date.now() - startedAt < timeoutMs) {
    last = await playerClient.evaluate(smokeProbeExpression(passphrase));

    if (last?.eventRows > 0) {
      return { ok: true, ...last, elapsedMs: Date.now() - startedAt };
    }

    // The classic UI can drop the first change event while it is still booting.
    if (!retried && !last?.passphraseVisible && Date.now() - startedAt > RELOAD_RETRY_AFTER_MS) {
      retried = true;
      await setArchiveFile(playerClient, archivePath);
    }

    await new Promise((resolve) => setTimeout(resolve, SMOKE_POLL_MS));
  }

  return { ok: false, ...last, elapsedMs: Date.now() - startedAt };
}

async function setArchiveFile(playerClient, archivePath) {
  const { root } = await playerClient.send("DOM.getDocument", { depth: 1 });
  const { nodeId } = await playerClient.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: 'input[type="file"]'
  });

  if (!nodeId) {
    throw new Error("Player has no file input");
  }

  await playerClient.send("DOM.setFileInputFiles", { nodeId, files: [archivePath] });
  await playerClient.evaluate(`
    (() => {
      document
        .querySelector('input[type="file"]')
        ?.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
}

function smokeProbeExpression(passphrase) {
  return `
    (() => {
      const passphrase = ${JSON.stringify(passphrase ?? "")};
      const field = Array.from(document.querySelectorAll('input[type="password"]')).find(
        (input) => input.getClientRects().length > 0
      );
      let passphraseSubmitted = false;

      // A dialog that stays open (or opens again) is submitted again after a short pause.
      if (field && passphrase && Date.now() - (window.__wbSmokeSubmittedAt ?? 0) > 1500) {
        window.__wbSmokeSubmittedAt = Date.now();
        // The native setter keeps React's controlled input in sync with the typed value.
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, passphrase);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        const form = field.closest('form');
        // Submit through the form's own button: the classic dialog reads its value ("confirm").
        form?.requestSubmit(form.querySelector('[type="submit"]') ?? undefined);
        passphraseSubmitted = true;
      }

      return {
        eventRows: document.querySelectorAll(${JSON.stringify(EVENT_ROW_SELECTOR)}).length,
        passphraseVisible: Boolean(field),
        passphraseSubmitted,
        error: (document.querySelector(${JSON.stringify(ERROR_SELECTOR)})?.textContent ?? '').trim() || null
      };
    })()
  `;
}
