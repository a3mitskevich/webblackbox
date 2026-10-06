export type CdpCommandOutcome<TResult> =
  | {
      ok: true;
      value: TResult;
    }
  | {
      ok: false;
      /** The CDP error message, or `timeout`. */
      error: string;
    };

export const CDP_COMMAND_TIMEOUT_ERROR = "timeout";

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
      (error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    ),
    new Promise<CdpCommandOutcome<TResult>>((resolve) => {
      timer = setTimeout(
        () => {
          resolve({ ok: false, error: CDP_COMMAND_TIMEOUT_ERROR });
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
