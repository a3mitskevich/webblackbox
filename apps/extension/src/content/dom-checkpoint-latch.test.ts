import { RRWEB_RAW_TYPE } from "@webblackbox/protocol";
import type { RawRecorderEvent } from "@webblackbox/recorder";
import { describe, expect, it, vi } from "vitest";

import { createDomCheckpointLatch } from "./dom-checkpoint-latch.js";

const raw = (rawType: string) => ({ rawType }) as unknown as RawRecorderEvent;

describe("createDomCheckpointLatch", () => {
  it("asks for one checkpoint after the queue drains, however many rrweb batches it dropped", () => {
    const request = vi.fn();
    const latch = createDomCheckpointLatch(request);

    for (let overflow = 0; overflow < 50; overflow += 1) {
      latch.noteDropped([raw("click"), raw(RRWEB_RAW_TYPE)]);
    }

    expect(request).not.toHaveBeenCalled();
    latch.queueDrained();
    latch.queueDrained();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("owes nothing for other dropped events or after a reset", () => {
    const request = vi.fn();
    const latch = createDomCheckpointLatch(request);

    latch.noteDropped([raw("click")]);
    latch.queueDrained();
    latch.noteDropped([raw(RRWEB_RAW_TYPE)]);
    latch.reset();
    latch.queueDrained();

    expect(request).not.toHaveBeenCalled();
  });
});
