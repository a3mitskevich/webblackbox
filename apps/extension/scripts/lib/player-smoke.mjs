// Thin Player smoke for the extension e2e: the exported archive opens with its passphrase in the
// Player, the session header appears and the Activity feed lists events. It drives the Player only
// through its stable `data-testid` hooks and checks no archive data (the player-sdk checks in
// `archive-checks.mjs` do that; the Player's own UI is covered by `e2e:player`).

const FILE_INPUT_SELECTOR = '[data-testid="archive-input"]';
const PASSPHRASE_SELECTOR = '[data-testid="passphrase-input"]';
const EVENT_ROW_SELECTOR = '[data-testid="event-row"]';
const SESSION_SELECTOR = '[data-testid="session"]';
const ERROR_SELECTOR = '[data-testid="archive-error"]';
const SMOKE_POLL_MS = 250;
/** A passphrase dialog that stays open (or opens again) is submitted again after this pause. */
const RESUBMIT_AFTER_MS = 1_500;

/** The selector that tells the Player has booted and accepts an archive. */
export const PLAYER_READY_SELECTOR = `[data-testid="player"] ${FILE_INPUT_SELECTOR}`;

/**
 * Loads `archivePath` into the Player open on `playerClient` (a CDP page client) and waits for
 * the session header and event rows. Resolves `{ ok, eventRows, ... }`; the caller asserts.
 */
export async function runPlayerSmoke({ playerClient, archivePath, passphrase, timeoutMs }) {
  await setArchiveFile(playerClient, archivePath);

  const startedAt = Date.now();
  let last = null;

  while (Date.now() - startedAt < timeoutMs) {
    last = await playerClient.evaluate(smokeProbeExpression(passphrase));

    if (last?.session && last.eventRows > 0) {
      return { ok: true, ...last, elapsedMs: Date.now() - startedAt };
    }

    if (last?.error) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, SMOKE_POLL_MS));
  }

  return { ok: false, ...last, elapsedMs: Date.now() - startedAt };
}

async function setArchiveFile(playerClient, archivePath) {
  const { root } = await playerClient.send("DOM.getDocument", { depth: 1 });
  const { nodeId } = await playerClient.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: FILE_INPUT_SELECTOR
  });

  if (!nodeId) {
    throw new Error("Player has no archive file input");
  }

  // setFileInputFiles fires `change` itself; a second event would start a second load.
  await playerClient.send("DOM.setFileInputFiles", { nodeId, files: [archivePath] });
}

function smokeProbeExpression(passphrase) {
  return `
    (() => {
      const passphrase = ${JSON.stringify(passphrase ?? "")};
      const field = document.querySelector(${JSON.stringify(PASSPHRASE_SELECTOR)});
      let passphraseSubmitted = false;

      if (field && passphrase && Date.now() - (window.__wbSmokeSubmittedAt ?? 0) > ${RESUBMIT_AFTER_MS}) {
        window.__wbSmokeSubmittedAt = Date.now();
        // The native setter keeps React's controlled input in sync with the typed value.
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, passphrase);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        const form = field.closest('form');
        form?.requestSubmit(form.querySelector('[type="submit"]') ?? undefined);
        passphraseSubmitted = true;
      }

      return {
        session: Boolean(document.querySelector(${JSON.stringify(SESSION_SELECTOR)})),
        eventRows: document.querySelectorAll(${JSON.stringify(EVENT_ROW_SELECTOR)}).length,
        passphraseVisible: Boolean(field),
        passphraseSubmitted,
        error: (document.querySelector(${JSON.stringify(ERROR_SELECTOR)})?.textContent ?? '').trim() || null
      };
    })()
  `;
}
