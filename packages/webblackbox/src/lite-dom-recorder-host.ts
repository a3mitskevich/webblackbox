import type { CapturePolicy, RrwebEventBatchPayload } from "@webblackbox/protocol";

import type {
  DomRecorder,
  DomRecorderContext,
  DomRecorderFactory,
  DomRecorderPageMessage
} from "./types.js";

type DomRecorderHostDeps = {
  factory: DomRecorderFactory | undefined;
  /** Queues one rrweb batch as a raw `rrwebRecord` event. */
  emit: (payload: RrwebEventBatchPayload, mono: number) => void;
  /** The recorder disabled itself: the agent's own DOM capture takes over. */
  onFallback: () => void;
};

/**
 * Runs the capture agent's DOM recorder (rrweb): one per recording in the top frame while the
 * profile records any DOM, restarted when the policy really changes (hosts resend equal policies
 * as new objects; a restart costs a full snapshot). A recorder that disabled itself (element
 * limit, start failure) is not restarted under the same policy: the agent's own DOM capture keeps
 * the page until the next recording.
 */
export class LiteDomRecorderHost {
  private recorder: DomRecorder | null = null;
  private policyKey: string | null = null;
  private disabledPolicyKey: string | null = null;

  public constructor(private readonly deps: DomRecorderHostDeps) {}

  /** True while a recorder runs: the agent's own DOM capture stays off. */
  public get isRecording(): boolean {
    return this.recorder !== null;
  }

  /** A new recording: a recorder disabled in the last one may try again. */
  public resetForNewRecording(): void {
    this.disabledPolicyKey = null;
  }

  public sync(
    shouldRecord: boolean,
    policy: CapturePolicy,
    mode: DomRecorderContext["mode"]
  ): void {
    const factory = this.deps.factory;
    const policyKey = JSON.stringify(policy);
    const wanted = shouldRecord && factory !== undefined && this.disabledPolicyKey !== policyKey;

    if (this.recorder && (!wanted || this.policyKey !== policyKey)) {
      this.stop();
    }

    if (!wanted || this.recorder || !factory) {
      return;
    }

    this.policyKey = policyKey;
    let disabledWhileStarting = false;
    let recorder: DomRecorder | null = null;
    const onDisabled = (): void => {
      if (this.recorder === null) {
        disabledWhileStarting = true;
        return;
      }

      if (this.recorder !== recorder) {
        return;
      }

      this.recorder = null;
      this.disabledPolicyKey = policyKey;
      this.deps.onFallback();
    };

    try {
      recorder = factory({ policy, mode, emit: this.deps.emit, onDisabled });
    } catch {
      // A recorder that fails to start leaves the agent's own DOM capture in charge.
      recorder = null;
    }

    if (!recorder || disabledWhileStarting) {
      this.disabledPolicyKey = policyKey;
      return;
    }

    this.recorder = recorder;
  }

  public flush(): void {
    this.recorder?.flush();
  }

  /** Waits until the events buffered so far reached the agent (page-world recorders). */
  public async drain(): Promise<void> {
    const recorder = this.recorder;

    if (!recorder) {
      return;
    }

    if (recorder.drain) {
      await recorder.drain();
      return;
    }

    recorder.flush();
  }

  /** The host lost rrweb events on their way out: a fresh full snapshot makes replay whole again. */
  public checkpoint(): void {
    this.recorder?.checkpoint?.();
  }

  public receive(message: DomRecorderPageMessage): void {
    this.recorder?.receive?.(message);
  }

  public stop(): void {
    const recorder = this.recorder;
    this.recorder = null;
    this.policyKey = null;
    recorder?.stop();
  }
}
