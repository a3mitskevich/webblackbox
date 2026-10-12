/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CAPTURE_POLICY,
  type CapturePolicy,
  type RrwebEventBatchPayload
} from "@webblackbox/protocol";

import { DOM_RECORDER_MAX_ELEMENTS, RRWEB_MUTATION_MAX_CHANGES } from "./rrweb-pressure.js";
import { createRrwebDomRecorderWith, type RrwebRecorderRuntime } from "./rrweb-recorder.js";
import type { DomRecorder } from "./types.js";

const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;

function policyWith(
  categories: Partial<CapturePolicy["categories"]>,
  redaction: Partial<CapturePolicy["redaction"]> = {}
): CapturePolicy {
  return {
    ...DEFAULT_CAPTURE_POLICY,
    categories: { ...DEFAULT_CAPTURE_POLICY.categories, ...categories },
    redaction: { ...DEFAULT_CAPTURE_POLICY.redaction, ...redaction }
  };
}

type Timer = { callback: () => void; ms: number; cleared: boolean };

function createRuntime(elements: { count: number | null }) {
  const timers: Timer[] = [];
  let now = 0;
  const runtime: RrwebRecorderRuntime = {
    now: () => now,
    setTimeout: (callback, ms) => {
      timers.push({ callback, ms, cleared: false });
      return (timers.length - 1) as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer) => {
      const entry = timers[timer as unknown as number];

      if (entry) {
        entry.cleared = true;
      }
    },
    countElements: () => elements.count ?? document.getElementsByTagName("*").length
  };

  return {
    runtime,
    timers,
    advance: (ms: number) => {
      now += ms;
    },
    /** Runs the pending timers that are at least `minMs` long (the pause timer, not the batch one). */
    fire: (minMs: number) => {
      for (const timer of timers.filter((entry) => !entry.cleared && entry.ms >= minMs)) {
        timer.cleared = true;
        timer.callback();
      }
    }
  };
}

function start(policy: CapturePolicy, runtime: RrwebRecorderRuntime) {
  const batches: RrwebEventBatchPayload[] = [];
  let disabled = 0;
  const recorder = createRrwebDomRecorderWith(
    {
      policy,
      mode: "lite",
      emit: (payload) => {
        batches.push(payload);
      },
      onDisabled: () => {
        disabled += 1;
      }
    },
    runtime
  );
  running = recorder;
  return { recorder, batches, disabledCount: () => disabled };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let running: DomRecorder | null = null;

afterEach(() => {
  running?.stop();
  running = null;
  document.body.innerHTML = "";
});

describe("rrweb pressure mode", () => {
  it("leaves pages over the element limit to the agent's own capture", () => {
    const { runtime } = createRuntime({ count: DOM_RECORDER_MAX_ELEMENTS + 1 });
    const { recorder, batches } = start(policyWith({ dom: "masked" }), runtime);

    expect(recorder).toBeNull();
    expect(batches).toEqual([
      {
        schema: "rrweb/v2",
        events: [],
        recorder: {
          status: "disabled",
          reason: "element-limit",
          elements: DOM_RECORDER_MAX_ELEMENTS + 1
        }
      }
    ]);
  });

  it("pauses on an oversized change set, drops it, and resumes with a fresh full snapshot", async () => {
    document.body.innerHTML = "<main id='app'><p>start</p></main>";
    const clock = createRuntime({ count: null });
    const { recorder, batches } = start(policyWith({ dom: "masked" }), clock.runtime);

    expect(recorder).not.toBeNull();
    expect(batches[0]?.events.some((event) => event.type === FULL_SNAPSHOT)).toBe(true);

    const app = document.getElementById("app")!;
    app.append(
      ...Array.from({ length: RRWEB_MUTATION_MAX_CHANGES + 10 }, (_, index) => {
        const row = document.createElement("i");
        row.textContent = String(index);
        return row;
      })
    );
    await settle();

    const paused = batches.at(-1)!;
    expect(paused.recorder).toEqual({ status: "paused", reason: "mutation-size" });
    expect(paused.events.some((event) => event.type === INCREMENTAL)).toBe(false);

    // Changes during the pause are not recorded.
    app.append(document.createElement("b"));
    await settle();
    expect(batches.at(-1)).toBe(paused);

    clock.advance(10_000);
    clock.fire(1_000);

    const resumed = batches.at(-1)!;
    expect(resumed.recorder).toEqual({ status: "resumed" });
    expect(resumed.events.map((event) => event.type)).toContain(FULL_SNAPSHOT);
  });

  it("disables itself when the page outgrew the element limit by the resume", async () => {
    document.body.innerHTML = "<main id='app'></main>";
    const elements = { count: null as number | null };
    const clock = createRuntime(elements);
    const { batches, disabledCount } = start(policyWith({ dom: "masked" }), clock.runtime);
    const app = document.getElementById("app")!;
    app.append(
      ...Array.from({ length: RRWEB_MUTATION_MAX_CHANGES + 1 }, () => document.createElement("i"))
    );
    await settle();

    elements.count = DOM_RECORDER_MAX_ELEMENTS + 5;
    clock.fire(1_000);

    expect(batches.at(-1)?.recorder).toEqual({
      status: "disabled",
      reason: "element-limit",
      elements: DOM_RECORDER_MAX_ELEMENTS + 5
    });
    expect(disabledCount()).toBe(1);
  });

  it("does not resume after Stop", async () => {
    document.body.innerHTML = "<main id='app'></main>";
    const clock = createRuntime({ count: null });
    const { recorder, batches } = start(policyWith({ dom: "masked" }), clock.runtime);
    document
      .getElementById("app")!
      .append(
        ...Array.from({ length: RRWEB_MUTATION_MAX_CHANGES + 1 }, () => document.createElement("i"))
      );
    await settle();
    const count = batches.length;

    recorder!.stop();
    clock.fire(1_000);

    expect(batches).toHaveLength(count);
  });
});

describe("rrweb under a profile without content masking (Full capture)", () => {
  it("records attributes and hidden fields as they are", () => {
    document.body.innerHTML = `
      <input type="hidden" name="csrf" value="CSRF-123" />
      <div title="alice@example.com" data-token="TOKEN-1" onclick="go()">Hi</div>
      <option value="opt-1">One</option>`;
    const { runtime } = createRuntime({ count: null });
    const { batches } = start(
      policyWith(
        { dom: "allow", inputs: "allow" },
        { contentRedaction: false, blockedSelectors: [] }
      ),
      runtime
    );
    const json = JSON.stringify(batches);

    for (const value of ["CSRF-123", "alice@example.com", "TOKEN-1", "go()", "opt-1"]) {
      expect(json).toContain(value);
    }
  });

  it("still masks what the categories leave out", () => {
    document.body.innerHTML = `<input id="name" value="Alice" /><p>Visible text</p>`;
    const { runtime } = createRuntime({ count: null });
    const { batches } = start(
      policyWith(
        { dom: "masked", inputs: "length-only" },
        { contentRedaction: false, blockedSelectors: [] }
      ),
      runtime
    );
    const json = JSON.stringify(batches);

    expect(json).not.toContain("Alice");
    expect(json).not.toContain("Visible text");
  });
});
