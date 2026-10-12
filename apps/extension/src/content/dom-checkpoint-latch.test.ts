import { RRWEB_RAW_TYPE } from "@webblackbox/protocol";
import type { RawRecorderEvent } from "@webblackbox/recorder";
import { describe, expect, it, vi } from "vitest";

import { createDomCheckpointLatch } from "./dom-checkpoint-latch.js";

const raw = (rawType: string) => ({ rawType }) as unknown as RawRecorderEvent;
const LOW_WATER = 600;

describe("createDomCheckpointLatch", () => {
  it("asks for one checkpoint once the queue has room, however many rrweb batches it dropped", () => {
    const request = vi.fn(() => true);
    const latch = createDomCheckpointLatch(request, LOW_WATER);

    for (let overflow = 0; overflow < 50; overflow += 1) {
      latch.noteDropped([raw("click"), raw(RRWEB_RAW_TYPE)]);
      latch.queueFlushed(1_150);
    }

    expect(request).not.toHaveBeenCalled();
    latch.queueFlushed(LOW_WATER);
    latch.queueFlushed(0);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps the checkpoint owed while no recorder takes it", () => {
    const request = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const latch = createDomCheckpointLatch(request, LOW_WATER);

    latch.noteDropped([raw(RRWEB_RAW_TYPE)]);
    latch.queueFlushed(0);
    latch.queueFlushed(0);
    latch.queueFlushed(0);

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("owes nothing for other dropped events or after a reset", () => {
    const request = vi.fn(() => true);
    const latch = createDomCheckpointLatch(request, LOW_WATER);

    latch.noteDropped([raw("click")]);
    latch.queueFlushed(0);
    latch.noteDropped([raw(RRWEB_RAW_TYPE)]);
    latch.reset();
    latch.queueFlushed(0);

    expect(request).not.toHaveBeenCalled();
  });
});
