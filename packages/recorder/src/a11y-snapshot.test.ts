import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  validateEvent,
  type CapturePolicy,
  type DomA11ySnapshotData,
  type RecorderConfig,
  type RedactionProfile,
  type WebBlackboxEvent
} from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import { WebBlackboxRecorder } from "./recorder.js";

const TREE = [
  "- main:",
  '  - heading "Sign in" [level=1]',
  '  - textbox "Email" [required]',
  '  - textbox "Password" [masked]',
  '  - button "Reset token"',
  '  - alert: "Wrong password for jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXZhbHVl"'
].join("\n");

function snapshot(overrides: Partial<DomA11ySnapshotData> = {}): DomA11ySnapshotData {
  return {
    trigger: { kind: "action", rawType: "click", delayMs: 700 },
    url: "https://app.example.com/login?next=%2Faccount&token=SECRET",
    title: "Sign in",
    viewport: { w: 1280, h: 720, scrollX: 0, scrollY: 0 },
    scope: "viewport",
    tree: TREE,
    nodeCount: 6,
    omittedNodes: 0,
    truncated: false,
    masking: "masked",
    durationMs: 2.4,
    ...overrides
  };
}

function recorder(
  options: {
    redaction?: Partial<RedactionProfile>;
    categories?: Partial<CapturePolicy["categories"]>;
  } = {}
): WebBlackboxRecorder {
  const redaction = { ...DEFAULT_RECORDER_CONFIG.redaction, ...options.redaction };
  const config: RecorderConfig = {
    ...DEFAULT_RECORDER_CONFIG,
    redaction,
    capturePolicy: {
      ...DEFAULT_CAPTURE_POLICY,
      categories: { ...DEFAULT_CAPTURE_POLICY.categories, ...options.categories },
      redaction
    }
  };

  return new WebBlackboxRecorder(config);
}

function ingest(
  target: WebBlackboxRecorder,
  rawType: string,
  payload: unknown,
  mono: number
): WebBlackboxEvent | undefined {
  return target.ingest({ source: "content", rawType, sid: "S-1", tabId: 7, t: mono, mono, payload })
    .event;
}

describe("dom.a11y.snapshot in the recorder", () => {
  it("records the snapshot with its text intact and the URL and credentials masked", () => {
    const event = ingest(recorder(), "a11ySnapshot", snapshot(), 1_000);
    const data = event?.data as DomA11ySnapshotData;

    expect(event?.type).toBe("dom.a11y.snapshot");
    expect(validateEvent(event).success).toBe(true);
    // "Password" and "token" are words on the page, not secrets: the tree is not hashed away.
    expect(data.tree).toContain('- textbox "Password" [masked]');
    expect(data.tree).toContain('- button "Reset token"');
    expect(data.tree).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(data.url).not.toContain("SECRET");
    expect(event?.privacy).toMatchObject({ category: "dom", sensitivity: "high" });
  });

  it("applies the DOM value patterns to the tree and title", () => {
    const event = ingest(
      recorder({ redaction: { valuePatterns: [{ pattern: "Sign in", targets: ["dom"] }] } }),
      "a11ySnapshot",
      snapshot(),
      1_000
    );
    const data = event?.data as DomA11ySnapshotData;

    expect(data.tree).not.toContain("Sign in");
    expect(data.title).not.toContain("Sign in");
  });

  it("records as is with masking off", () => {
    const event = ingest(
      recorder({ redaction: { contentRedaction: false } }),
      "a11ySnapshot",
      snapshot({ masking: "none" }),
      1_000
    );

    expect((event?.data as DomA11ySnapshotData).tree).toBe(TREE);
  });

  it("drops malformed snapshots", () => {
    const target = recorder();

    expect(ingest(target, "a11ySnapshot", { tree: 42 }, 1_000)).toBeUndefined();
    expect(ingest(target, "a11ySnapshot", { ...snapshot(), extra: true }, 1_000)).toBeUndefined();
  });

  it("is a policy violation when the profile records no DOM", () => {
    const event = ingest(recorder({ categories: { dom: "off" } }), "a11ySnapshot", snapshot(), 1);

    expect(event?.type).toBe("privacy.violation");
  });

  it("is a policy violation when the page masked less than the profile requires", () => {
    const wireframe = ingest(
      recorder({ categories: { dom: "wireframe" } }),
      "a11ySnapshot",
      snapshot({ masking: "masked" }),
      1_000
    );
    const unmasked = ingest(recorder(), "a11ySnapshot", snapshot({ masking: "none" }), 1_000);
    const stricter = ingest(
      recorder({ redaction: { contentRedaction: false } }),
      "a11ySnapshot",
      snapshot({ masking: "wireframe", tree: "- main" }),
      1_000
    );

    expect(wireframe?.type).toBe("privacy.violation");
    expect(JSON.stringify(wireframe?.data)).not.toContain("Sign in");
    expect(unmasked?.type).toBe("privacy.violation");
    expect(stricter?.type).toBe("dom.a11y.snapshot");
  });

  it("links the snapshot to the click that triggered it and to its action", () => {
    const target = recorder();
    const click = ingest(target, "click", { x: 1, y: 2 }, 1_000);
    const later = ingest(target, "click", { x: 3, y: 4 }, 1_400);
    const event = ingest(target, "a11ySnapshot", snapshot(), 1_700);
    const data = event?.data as DomA11ySnapshotData;

    expect(click?.id).toBeDefined();
    // Taken 700 ms after its trigger: the first click, not the one folded in later.
    expect(data.trigger.eventId).toBe(click?.id);
    expect(data.trigger.eventId).not.toBe(later?.id);
    expect(event?.ref?.act).toBe(later?.ref?.act);
  });

  it("links an error snapshot to the error and keeps an id the host already set", () => {
    const target = recorder({ categories: { console: "allow" } });
    const error = ingest(target, "pageError", { message: "boom" }, 5_000);
    const linked = ingest(
      target,
      "a11ySnapshot",
      snapshot({ trigger: { kind: "error", rawType: "pageError", delayMs: 300 } }),
      5_300
    );
    const preset = ingest(
      target,
      "a11ySnapshot",
      snapshot({ trigger: { kind: "error", eventId: "E-cdp-1", delayMs: 300 } }),
      5_400
    );

    expect((linked?.data as DomA11ySnapshotData).trigger.eventId).toBe(error?.id);
    expect((preset?.data as DomA11ySnapshotData).trigger.eventId).toBe("E-cdp-1");
  });

  it("leaves a snapshot unlinked when no trigger event is near", () => {
    const target = recorder();
    ingest(target, "click", { x: 1, y: 2 }, 1_000);
    const event = ingest(target, "a11ySnapshot", snapshot(), 60_000);

    expect((event?.data as DomA11ySnapshotData).trigger.eventId).toBeUndefined();
  });
});
