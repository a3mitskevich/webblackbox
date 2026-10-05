import type { CdpRouter } from "@webblackbox/cdp-router";

export type CdpCommandOutcome<TResult> =
  | {
      ok: true;
      value: TResult;
    }
  | {
      ok: false;
    };

export function withCdpCommandTimeout<TResult>(
  task: Promise<TResult>,
  timeoutMs: number
): Promise<CdpCommandOutcome<TResult>> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return Promise.race<CdpCommandOutcome<TResult>>([
    task.then(
      (value) => ({
        ok: true,
        value
      }),
      () => ({
        ok: false
      })
    ),
    new Promise<CdpCommandOutcome<TResult>>((resolve) => {
      timer = setTimeout(
        () => {
          resolve({ ok: false });
        },
        Math.max(0, timeoutMs)
      );
    })
  ]).finally(() => {
    if (timer !== null) {
      clearTimeout(timer);
    }
  });
}

export type ChildSessionRouter = Pick<CdpRouter, "enableBaseline" | "enableAutoAttach" | "send">;

const OPTIONAL_CHILD_SESSION_DOMAINS = ["DOMStorage.enable", "Performance.enable"] as const;

/**
 * Enables capture on a newly attached child target (iframe, worker). Every step is bounded by
 * `stepTimeoutMs`: a child target that goes away mid-handshake can leave a `chrome.debugger`
 * command pending forever, and this runs on the session queue, so an unbounded wait would stall
 * every later capture task and `stopSession`. Returns false when a required step failed or timed
 * out; optional domains are best effort.
 */
export async function enableChildSessionCapture(
  router: ChildSessionRouter,
  tabId: number,
  sessionId: string,
  stepTimeoutMs: number
): Promise<boolean> {
  const requiredSteps = [
    () => router.enableBaseline(tabId, sessionId),
    () => router.enableAutoAttach(tabId, undefined, sessionId)
  ];

  for (const step of requiredSteps) {
    const outcome = await withCdpCommandTimeout(step(), stepTimeoutMs);

    if (!outcome.ok) {
      return false;
    }
  }

  for (const method of OPTIONAL_CHILD_SESSION_DOMAINS) {
    await withCdpCommandTimeout(router.send({ tabId, sessionId }, method), stepTimeoutMs);
  }

  return true;
}
