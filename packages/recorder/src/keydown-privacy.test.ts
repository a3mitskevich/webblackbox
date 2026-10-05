import { describe, expect, it } from "vitest";

import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  type CapturePolicy,
  type RecorderConfig
} from "@webblackbox/protocol";

import { WebBlackboxRecorder } from "./recorder.js";
import type { RawRecorderEvent } from "./types.js";

const ALLOW_INPUTS_CONFIG: RecorderConfig = {
  ...DEFAULT_RECORDER_CONFIG,
  capturePolicy: {
    ...DEFAULT_CAPTURE_POLICY,
    categories: {
      ...DEFAULT_CAPTURE_POLICY.categories,
      inputs: "allow"
    }
  } satisfies CapturePolicy
};

function rawKeydown(payload: Record<string, unknown>): RawRecorderEvent {
  return {
    source: "content",
    rawType: "keydown",
    tabId: 1,
    sid: "S-keydown",
    t: 1_000,
    mono: 1_000,
    payload
  };
}

function ingestKeydown(
  payload: Record<string, unknown>,
  config: RecorderConfig = DEFAULT_RECORDER_CONFIG
) {
  const { event } = new WebBlackboxRecorder(config).ingest(rawKeydown(payload));

  if (!event) {
    throw new Error("keydown was dropped");
  }

  return event;
}

describe("recorder keydown privacy (defence in depth)", () => {
  it("redacts printable keys from producers that do not redact editable targets", () => {
    const event = ingestKeydown({ key: "q", code: "KeyQ", target: { tag: "INPUT" } });

    expect(event.type).toBe("user.keydown");
    expect(event.data).toEqual({
      key: "[REDACTED]",
      keyRedacted: true,
      target: { tag: "INPUT" }
    });
    expect(event.privacy?.redacted).toBe(true);
  });

  it("treats keydowns without target information as editable", () => {
    expect(ingestKeydown({ key: "q", code: "KeyQ" }).data).toMatchObject({
      key: "[REDACTED]"
    });
    expect(ingestKeydown({ code: "KeyQ" }).data).not.toHaveProperty("code");
  });

  it("trusts explicit producer flags over the target tag", () => {
    const checkbox = ingestKeydown({
      key: " ",
      code: "Space",
      editable: false,
      sensitiveTarget: false,
      target: { tag: "INPUT" }
    });
    const editor = ingestKeydown({
      key: "q",
      code: "KeyQ",
      editable: true,
      target: { tag: "DIV" }
    });

    expect(checkbox.data).toMatchObject({ key: " ", code: "Space" });
    expect(editor.data).toMatchObject({ key: "[REDACTED]" });
  });

  it("keeps non-editable hotkeys, service keys and shortcut chords", () => {
    expect(ingestKeydown({ key: "j", code: "KeyJ", target: { tag: "BODY" } }).data).toMatchObject({
      key: "j",
      code: "KeyJ"
    });
    expect(ingestKeydown({ key: "Enter", code: "Enter", target: { tag: "INPUT" } }).data).toEqual({
      key: "Enter",
      code: "Enter",
      target: { tag: "INPUT" }
    });
    expect(
      ingestKeydown({ key: "s", code: "KeyS", ctrlKey: true, target: { tag: "TEXTAREA" } }).data
    ).toMatchObject({ key: "s", code: "KeyS" });
  });

  it("keeps editable keys with inputs allowed but never sensitive ones", () => {
    const editable = ingestKeydown(
      { key: "q", code: "KeyQ", editable: true, target: { tag: "INPUT" } },
      ALLOW_INPUTS_CONFIG
    );
    const sensitive = ingestKeydown(
      { key: "q", code: "KeyQ", editable: true, sensitiveTarget: true, target: { tag: "INPUT" } },
      ALLOW_INPUTS_CONFIG
    );

    expect(editable.data).toMatchObject({ key: "q", code: "KeyQ" });
    expect(sensitive.data).toMatchObject({ key: "[REDACTED]", keyRedacted: true });
    expect(sensitive.data).not.toHaveProperty("code");
  });

  it("strips code from payloads already marked as redacted", () => {
    const event = ingestKeydown({ key: "[REDACTED]", keyRedacted: true, code: "KeyQ" });

    expect(event.data).toEqual({ key: "[REDACTED]", keyRedacted: true });
  });

  it("still starts action spans for Enter in editable fields", () => {
    const event = ingestKeydown({ key: "Enter", code: "Enter", editable: true });

    expect(event.ref?.act).toBeDefined();
  });
});
