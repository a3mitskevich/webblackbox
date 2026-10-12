import { describe, expect, it, vi } from "vitest";

import {
  CONTENT_AGENT_GLOBAL_KEY,
  publishContentAgent,
  readContentAgent,
  type ContentAgentApi
} from "./content-agent-api.js";

function createApi(): ContentAgentApi {
  return {
    createContentCaptureAgent: vi.fn(),
    loadKeyboardMarkerLabel: vi.fn(async () => "Keyboard marker")
  };
}

describe("content agent handoff", () => {
  it("reads back the API the agent published in the same world", () => {
    const world = {};
    const api = createApi();

    expect(readContentAgent(world)).toBeNull();

    publishContentAgent(world, api);
    const read = readContentAgent(world);

    expect(read?.createContentCaptureAgent).toBe(api.createContentCaptureAgent);
    expect(read?.loadKeyboardMarkerLabel).toBe(api.loadKeyboardMarkerLabel);
    expect(Object.isFrozen(read)).toBe(true);
  });

  it("uses a symbol key, so it adds no string-named global", () => {
    const world = {};
    publishContentAgent(world, createApi());

    expect(Object.keys(world)).toEqual([]);
    expect(Object.getOwnPropertySymbols(world)).toEqual([CONTENT_AGENT_GLOBAL_KEY]);
    expect(CONTENT_AGENT_GLOBAL_KEY).toBe(Symbol.for("webblackbox.contentAgent"));
  });

  it("ignores a value of another shape under the key", () => {
    expect(readContentAgent({ [CONTENT_AGENT_GLOBAL_KEY]: 1 })).toBeNull();
    expect(
      readContentAgent({ [CONTENT_AGENT_GLOBAL_KEY]: { createContentCaptureAgent: () => null } })
    ).toBeNull();
  });
});
